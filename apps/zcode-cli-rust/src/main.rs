//! zcode-cli-rust 唯一二进制与 composition root。
//!
//! 只在这里组装具体 adapter；application 代码不得 import adapter 或做
//! 文件/网络/进程 IO。crate 边界见 .agents/specs/cli-rust-runtime.md。

fn main() {
    // M0 骨架：尚未接线任何子命令。
    println!("zcode-cli-rust {}", env!("CARGO_PKG_VERSION"));
}
