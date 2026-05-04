fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS")
        .ok()
        .unwrap_or_default();

    if target_os == "macos" {
        // macOS dynamic loader resolves Node-API symbols (napi_*) at
        // runtime against the host process. Tell the linker to allow
        // unresolved symbols at link time.
        println!("cargo:rustc-cdylib-link-arg=-Wl,-undefined,dynamic_lookup");
    }

    if target_os == "windows" {
        // Linux's default behavior is the same as the macOS rule above
        // (allow unresolved symbols), so no extra args needed there.
        //
        // Windows is the only platform that actually requires explicit
        // setup: the napi_* symbols live in node.exe (the host process),
        // not in a separate DLL the loader can find at load time, so we:
        //
        //   1. Link against node.lib — an import library for node.exe's
        //      exported symbols. The wrapper `scripts/build-rust-napi.mjs`
        //      downloads it from nodejs.org for the running Node version
        //      and points cargo at its dir via RUSTFLAGS=-L native=<dir>
        //      before running this build. Without that, this link step
        //      fails with `cannot open input file 'node.lib'`.
        //
        //   2. Use Windows delay-loading on node.exe so the linker emits
        //      thunks that resolve those symbols at first call against
        //      the host process — instead of requiring node.exe.dll to
        //      be on PATH at load time, which it never is (node.exe is
        //      the executable hosting us).
        //
        //   3. Pull in `delayimp.lib`, the runtime support library that
        //      implements the delay-load thunks. Without it the linker
        //      emits the thunks but they have no `__delayLoadHelper2`
        //      to dispatch through.
        println!("cargo:rustc-link-lib=node");
        println!("cargo:rustc-cdylib-link-arg=/DELAYLOAD:node.exe");
        println!("cargo:rustc-cdylib-link-arg=delayimp.lib");
    }
}
