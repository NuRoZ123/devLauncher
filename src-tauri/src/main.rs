// Empêche l'ouverture d'une console Windows supplémentaire en release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    devlauncher_lib::run();
}
