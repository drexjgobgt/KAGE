fn main() {
    // Emit the Windows manifest (DPI awareness + per-monitor v2) and generate
    // the Tauri codegen context.
    tauri_build::build();

    // Media Foundation + DXGI are delay-loaded so KAGE still launches on
    // Windows N/KN editions without the media feature pack.
    #[cfg(windows)]
    if std::env::var_os("CARGO_FEATURE_HEADLESS_SIM").is_none() {
        println!("cargo:rustc-link-arg=/DELAYLOAD:mf.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:mfplat.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:mfreadwrite.dll");
        println!("cargo:rustc-link-lib=dylib=delayimp");
    }
}
