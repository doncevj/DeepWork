{
  "targets": [
    {
      "target_name": "lockdown",
      "sources": ["src/native/lockdown_mac.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include_dir\")"
      ],
      "link_settings": {
        "libraries": ["-framework AppKit"]
      },
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "GCC_ENABLE_OBJC_EXCEPTIONS": "YES",
        "CLANG_ENABLE_OBJC_ARC": "NO",
        "MACOSX_DEPLOYMENT_TARGET": "10.15"
      }
    }
  ]
}
