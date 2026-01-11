//! PaintBoard application entry point

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    paintboard_lib::run();
}
