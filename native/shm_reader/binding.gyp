{
  "targets": [
    {
      "target_name": "shm_reader",
      "sources": ["src/shm_reader.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": ["NAPI_VERSION=8"]
    }
  ]
}
