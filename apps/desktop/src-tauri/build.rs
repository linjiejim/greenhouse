fn main() {
    println!("cargo:rerun-if-env-changed=GREENHOUSE_UPDATER_ENDPOINT");
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "credentials",
            tauri_build::InlinedPlugin::new()
                .commands(&["read", "write"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("Desktop build configuration");
}
