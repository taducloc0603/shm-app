#include <napi.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <winternl.h>
#endif

namespace {

constexpr std::uint32_t H_QUOTE_SEQ = 0;
constexpr std::uint32_t H_CMD_SEQ = 4;
constexpr std::uint32_t H_ACK_SEQ = 8;
constexpr std::uint32_t H_ACK_CODE = 12;

constexpr std::uint32_t QUOTE_RING_OFFSET = 16;
constexpr std::uint32_t QUOTE_RING_SIZE = 64;
constexpr std::uint32_t QUOTE_MSG_SIZE = 48;

constexpr std::uint32_t Q_TS_OFFSET = 8;
constexpr std::uint32_t Q_BID_OFFSET = 16;
constexpr std::uint32_t Q_ASK_OFFSET = 24;
constexpr std::uint32_t Q_SYMBOL_OFFSET = 32;
constexpr std::uint32_t Q_SYMBOL_LEN = 16;

template <typename T>
T ReadValue(const std::uint8_t* base, std::size_t offset) {
  T val{};
  std::memcpy(&val, base + offset, sizeof(T));
  return val;
}

std::string CleanSymbol(const char* raw, std::size_t len) {
  std::string out;
  out.reserve(len);
  for (std::size_t i = 0; i < len; ++i) {
    const unsigned char c = static_cast<unsigned char>(raw[i]);
    if (c == 0) break;
    if (c >= 32 && c <= 126) out.push_back(static_cast<char>(c));
  }

  while (!out.empty() && out.back() == ' ') out.pop_back();
  return out;
}

#ifdef _WIN32
constexpr NTSTATUS STATUS_NO_MORE_ENTRIES_VALUE = static_cast<NTSTATUS>(0x8000001AL);
constexpr ACCESS_MASK DIRECTORY_QUERY_ACCESS = 0x0001;

using NtOpenDirectoryObjectFn = NTSTATUS(NTAPI*)(
    PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES);
using NtQueryDirectoryObjectFn = NTSTATUS(NTAPI*)(
    HANDLE, PVOID, ULONG, BOOLEAN, BOOLEAN, PULONG, PULONG);

struct ObjectDirectoryInformation {
  UNICODE_STRING name;
  UNICODE_STRING typeName;
};

std::wstring ToWide(const std::string& s) {
  if (s.empty()) return std::wstring();
  const int count = MultiByteToWideChar(
      CP_UTF8,
      0,
      s.c_str(),
      static_cast<int>(s.size()),
      nullptr,
      0);
  if (count <= 0) return std::wstring();

  std::wstring ws;
  ws.resize(static_cast<std::size_t>(count));
  MultiByteToWideChar(
      CP_UTF8,
      0,
      s.c_str(),
      static_cast<int>(s.size()),
      ws.data(),
      count);
  return ws;
}

std::string ToUtf8(const std::wstring& ws) {
  if (ws.empty()) return std::string();
  const int count = WideCharToMultiByte(
      CP_UTF8, 0, ws.data(), static_cast<int>(ws.size()), nullptr, 0, nullptr, nullptr);
  if (count <= 0) return std::string();

  std::string out(static_cast<std::size_t>(count), '\0');
  WideCharToMultiByte(
      CP_UTF8, 0, ws.data(), static_cast<int>(ws.size()), out.data(), count, nullptr, nullptr);
  return out;
}

bool StartsWith(const std::wstring& value, const std::wstring& prefix) {
  return value.size() >= prefix.size() &&
      std::equal(prefix.begin(), prefix.end(), value.begin());
}

std::vector<std::string> ScanMapsByPrefix(const std::string& prefix, std::string* error) {
  const std::wstring prefixWide = ToWide(prefix);
  if (prefixWide.empty()) {
    *error = "Memory prefix không hợp lệ.";
    return {};
  }

  const std::wstring localMarker = L"Local\\";
  const std::wstring globalMarker = L"Global\\";
  std::wstring objectPrefix = prefixWide;
  std::wstring publicMarker = localMarker;
  std::wstring directoryPath;

  if (StartsWith(prefixWide, globalMarker)) {
    objectPrefix = prefixWide.substr(globalMarker.size());
    publicMarker = globalMarker;
    directoryPath = L"\\BaseNamedObjects";
  } else {
    if (StartsWith(prefixWide, localMarker)) {
      objectPrefix = prefixWide.substr(localMarker.size());
    }
    DWORD sessionId = 0;
    if (!ProcessIdToSessionId(GetCurrentProcessId(), &sessionId)) {
      *error = "Không xác định được Windows session hiện tại.";
      return {};
    }
    directoryPath = L"\\Sessions\\" + std::to_wstring(sessionId) + L"\\BaseNamedObjects";
  }

  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  auto openDirectory = reinterpret_cast<NtOpenDirectoryObjectFn>(
      GetProcAddress(ntdll, "NtOpenDirectoryObject"));
  auto queryDirectory = reinterpret_cast<NtQueryDirectoryObjectFn>(
      GetProcAddress(ntdll, "NtQueryDirectoryObject"));
  if (!openDirectory || !queryDirectory) {
    *error = "Windows không cung cấp API liệt kê object namespace.";
    return {};
  }

  UNICODE_STRING directoryName{};
  directoryName.Buffer = directoryPath.data();
  directoryName.Length = static_cast<USHORT>(directoryPath.size() * sizeof(wchar_t));
  directoryName.MaximumLength = directoryName.Length;
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &directoryName, OBJ_CASE_INSENSITIVE, nullptr, nullptr);

  HANDLE directory = nullptr;
  const NTSTATUS openStatus = openDirectory(&directory, DIRECTORY_QUERY_ACCESS, &attributes);
  if (openStatus < 0 || !directory) {
    *error = "Không mở được Windows object namespace: " + std::to_string(openStatus);
    return {};
  }

  std::vector<std::string> results;
  std::vector<std::uint8_t> buffer(64 * 1024);
  ULONG context = 0;
  while (true) {
    ULONG returnedLength = 0;
    const NTSTATUS status = queryDirectory(
        directory, buffer.data(), static_cast<ULONG>(buffer.size()), TRUE, FALSE,
        &context, &returnedLength);
    if (status == STATUS_NO_MORE_ENTRIES_VALUE) break;
    if (status < 0) {
      *error = "Lỗi khi liệt kê shared memory: " + std::to_string(status);
      results.clear();
      break;
    }

    const auto* item = reinterpret_cast<const ObjectDirectoryInformation*>(buffer.data());
    const std::wstring name(item->name.Buffer, item->name.Length / sizeof(wchar_t));
    const std::wstring type(item->typeName.Buffer, item->typeName.Length / sizeof(wchar_t));
    if (type != L"Section" || !StartsWith(name, objectPrefix)) continue;

    const std::wstring publicName = publicMarker + name;
    HANDLE mapping = OpenFileMappingW(FILE_MAP_READ, FALSE, publicName.c_str());
    if (!mapping) continue;
    CloseHandle(mapping);
    results.push_back(ToUtf8(publicName));
  }

  CloseHandle(directory);
  return results;
}

Napi::Object BuildNotFoundRow(Napi::Env env, const std::string& mapName) {
  Napi::Object row = Napi::Object::New(env);
  row.Set("map_name", mapName);
  row.Set("status", "NOT_FOUND");
  return row;
}

Napi::Object BuildErrorRow(Napi::Env env, const std::string& mapName, const std::string& message) {
  Napi::Object row = Napi::Object::New(env);
  row.Set("map_name", mapName);
  row.Set("status", "ERROR");
  row.Set("message", message);
  return row;
}

Napi::Object ReadOneMap(Napi::Env env, const std::string& mapName) {
  const std::wstring mapWide = ToWide(mapName);
  if (mapWide.empty()) {
    return BuildErrorRow(env, mapName, "Map name không hợp lệ.");
  }

  HANDLE mapping = OpenFileMappingW(FILE_MAP_READ, FALSE, mapWide.c_str());
  if (!mapping) {
    const DWORD errCode = GetLastError();
    if (errCode == ERROR_FILE_NOT_FOUND || errCode == ERROR_INVALID_NAME) {
      return BuildNotFoundRow(env, mapName);
    }
    return BuildErrorRow(env, mapName, "OpenFileMappingW failed: " + std::to_string(errCode));
  }

  void* view = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 0);
  if (!view) {
    const DWORD errCode = GetLastError();
    CloseHandle(mapping);
    return BuildErrorRow(env, mapName, "MapViewOfFile failed: " + std::to_string(errCode));
  }

  const auto* bytes = static_cast<const std::uint8_t*>(view);

  bool stable = false;
  std::uint32_t quoteSeq = 0;
  std::uint32_t cmdSeq = 0;
  std::uint32_t ackSeq = 0;
  std::int32_t ackCode = 0;
  std::uint32_t slot = 0;
  std::uint32_t baseAddr = 0;
  std::int64_t timeMsc = 0;
  double bid = 0.0;
  double ask = 0.0;
  std::string symbol;
  std::uint32_t retriesUsed = 0;

  for (std::uint32_t i = 0; i < 4; ++i) {
    const std::uint32_t quoteSeq1 = ReadValue<std::uint32_t>(bytes, H_QUOTE_SEQ);
    cmdSeq = ReadValue<std::uint32_t>(bytes, H_CMD_SEQ);
    ackSeq = ReadValue<std::uint32_t>(bytes, H_ACK_SEQ);
    ackCode = ReadValue<std::int32_t>(bytes, H_ACK_CODE);

    slot = quoteSeq1 % QUOTE_RING_SIZE;
    baseAddr = QUOTE_RING_OFFSET + (slot * QUOTE_MSG_SIZE);

    timeMsc = ReadValue<std::int64_t>(bytes, baseAddr + Q_TS_OFFSET);
    bid = ReadValue<double>(bytes, baseAddr + Q_BID_OFFSET);
    ask = ReadValue<double>(bytes, baseAddr + Q_ASK_OFFSET);

    char rawSymbol[Q_SYMBOL_LEN] = {0};
    std::memcpy(rawSymbol, bytes + baseAddr + Q_SYMBOL_OFFSET, Q_SYMBOL_LEN);
    symbol = CleanSymbol(rawSymbol, Q_SYMBOL_LEN);

    const std::uint32_t quoteSeq2 = ReadValue<std::uint32_t>(bytes, H_QUOTE_SEQ);
    if (quoteSeq1 == quoteSeq2) {
      stable = true;
      quoteSeq = quoteSeq2;
      retriesUsed = i;
      break;
    }
  }

  UnmapViewOfFile(view);
  CloseHandle(mapping);

  if (!stable) {
    return BuildErrorRow(env, mapName, "Không lấy được snapshot ổn định sau nhiều lần thử.");
  }

  Napi::Object row = Napi::Object::New(env);
  row.Set("map_name", mapName);
  row.Set("status", "FOUND");
  row.Set("quote_seq", Napi::Number::New(env, quoteSeq));
  row.Set("cmd_seq", Napi::Number::New(env, cmdSeq));
  row.Set("ack_seq", Napi::Number::New(env, ackSeq));
  row.Set("ack_code", Napi::Number::New(env, ackCode));
  row.Set("slot", Napi::Number::New(env, slot));
  row.Set("base_addr", std::string("0x") + [] (std::uint32_t v) {
    const char* hex = "0123456789ABCDEF";
    std::string out;
    out.reserve(8);
    bool started = false;
    for (int i = 7; i >= 0; --i) {
      const unsigned n = (v >> (i * 4)) & 0xF;
      if (n != 0 || started || i == 0) {
        out.push_back(hex[n]);
        started = true;
      }
    }
    return out;
  }(baseAddr));
  row.Set("symbol", symbol);
  row.Set("bid", Napi::Number::New(env, bid));
  row.Set("ask", Napi::Number::New(env, ask));
  row.Set("spread", Napi::Number::New(env, ask - bid));
  row.Set("time_msc", Napi::Number::New(env, static_cast<double>(timeMsc)));
  row.Set("retries", Napi::Number::New(env, retriesUsed));
  return row;
}
#endif

Napi::Value ReadBatch(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "readBatch(mapNames): mapNames phải là array").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Array mapNames = info[0].As<Napi::Array>();
  const std::uint32_t len = mapNames.Length();
  Napi::Array out = Napi::Array::New(env, len);

  for (std::uint32_t i = 0; i < len; ++i) {
    std::string mapName;
    if (mapNames.Has(i)) {
      Napi::Value v = mapNames.Get(i);
      if (v.IsString()) {
        mapName = v.As<Napi::String>().Utf8Value();
      }
    }

    if (mapName.empty()) {
      Napi::Object row = Napi::Object::New(env);
      row.Set("map_name", "");
      row.Set("status", "ERROR");
      row.Set("message", "Map name rỗng.");
      out.Set(i, row);
      continue;
    }

#ifdef _WIN32
    out.Set(i, ReadOneMap(env, mapName));
#else
    Napi::Object row = Napi::Object::New(env);
    row.Set("map_name", mapName);
    row.Set("status", "UNSUPPORTED");
    row.Set("message", "Native shm_reader chỉ hỗ trợ Windows.");
    out.Set(i, row);
#endif
  }

  return out;
}

Napi::Value ScanByPrefix(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "scanByPrefix(prefix): prefix phải là string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

#ifdef _WIN32
  std::string error;
  const auto names = ScanMapsByPrefix(info[0].As<Napi::String>().Utf8Value(), &error);
  if (!error.empty()) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Array out = Napi::Array::New(env, names.size());
  for (std::size_t i = 0; i < names.size(); ++i) out.Set(i, names[i]);
  return out;
#else
  Napi::Error::New(env, "Scan shared memory chỉ hỗ trợ trên Windows.")
      .ThrowAsJavaScriptException();
  return env.Null();
#endif
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("readBatch", Napi::Function::New(env, ReadBatch));
  exports.Set("scanByPrefix", Napi::Function::New(env, ScanByPrefix));
  return exports;
}

}  // namespace

NODE_API_MODULE(shm_reader, Init)
