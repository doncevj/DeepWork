// DeepWork — macOS presentation options.
//
// Electron's setKiosk() sets the right options, then enters native fullscreen.
// AppKit manages presentation itself for a fullscreen Space, so it takes the
// options straight back and Cmd+Tab survives. Setting them here instead, with
// the window in simple fullscreen rather than a Space, means nothing comes
// along afterwards to undo them.

#import <AppKit/AppKit.h>
#include <napi.h>

namespace {

NSApplicationPresentationOptions g_saved_options = NSApplicationPresentationDefault;
bool g_have_saved = false;

// Apple's documented rules for a valid combination:
//   - HideMenuBar must be accompanied by HideDock
//   - DisableProcessSwitching, DisableForceQuit and DisableSessionTermination
//     must each be accompanied by HideDock or AutoHideDock
//   - AutoHide* and Hide* forms are mutually exclusive
// HideDock is present and no AutoHide* form is used, so this set is valid and
// setPresentationOptions will not raise. The @try is belt and braces.
NSApplicationPresentationOptions LockedOptions() {
  return NSApplicationPresentationHideDock |
         NSApplicationPresentationHideMenuBar |
         NSApplicationPresentationDisableAppleMenu |
         NSApplicationPresentationDisableProcessSwitching |
         NSApplicationPresentationDisableForceQuit |
         NSApplicationPresentationDisableSessionTermination |
         NSApplicationPresentationDisableHideApplication;
}

// Turn the lock on. Safe to call repeatedly; the first call is the one that
// records what to put back.
Napi::Value Engage(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  @try {
    if (!g_have_saved) {
      g_saved_options = [NSApp currentSystemPresentationOptions];
      g_have_saved = true;
    }
    [NSApp setPresentationOptions:LockedOptions()];
  } @catch (NSException* exception) {
    return Napi::Boolean::New(env, false);
  }

  return Napi::Boolean::New(env, true);
}

// Put back whatever was in effect before the session started.
Napi::Value Release(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  @try {
    [NSApp setPresentationOptions:(g_have_saved ? g_saved_options
                                                : NSApplicationPresentationDefault)];
    g_have_saved = false;
  } @catch (NSException* exception) {
    return Napi::Boolean::New(env, false);
  }

  return Napi::Boolean::New(env, true);
}

// Reads the live state rather than a cached flag, so it can tell us if
// something else has quietly taken the options back.
Napi::Value IsEngaged(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  NSApplicationPresentationOptions current = [NSApp currentSystemPresentationOptions];
  bool engaged =
      (current & NSApplicationPresentationDisableProcessSwitching) != 0;

  return Napi::Boolean::New(env, engaged);
}

// The raw bitmask macOS is actually applying. Decoded on the JavaScript side
// for logging, so a misbehaving lock can be read rather than guessed at.
Napi::Value CurrentOptions(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  NSApplicationPresentationOptions current = [NSApp currentSystemPresentationOptions];
  return Napi::Number::New(env, static_cast<double>(current));
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("engage", Napi::Function::New(env, Engage));
  exports.Set("release", Napi::Function::New(env, Release));
  exports.Set("isEngaged", Napi::Function::New(env, IsEngaged));
  exports.Set("currentOptions", Napi::Function::New(env, CurrentOptions));
  return exports;
}

}  // namespace

NODE_API_MODULE(lockdown, Init)
