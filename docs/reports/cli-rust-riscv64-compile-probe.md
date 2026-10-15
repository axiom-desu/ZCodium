# Rust CLI RISC-V 交叉编译探测

## 结果与边界

在源码 commit `064663c690e84d9e24a8a8c7edeaba62d4cc613a` 上，使用现有 Cargo.lock，**无源码/manifest/lock 修改**，成功编译链接 `riscv64gc-unknown-linux-gnu` 的 release CLI。

仅编译与 ELF 静态检查：**未执行 binary、未用 QEMU、未连接远端、未部署**。这不代表 TLS/SQLite/工具已在 RISC-V 运行通过，更不代表远端完整产品已支持该 ISA。

## 工具链与复现命令

- 编译宿主：Linux x86_64。
- Rust / Cargo：1.98.1；LLVM 22.1.8。
- C/linker：`riscv64-linux-gnu-gcc` 11.4.0（Ubuntu cross toolchain）。
- 添加 Rust std target：`rustup target add riscv64gc-unknown-linux-gnu`。

从仓库根执行：

```bash
CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_GNU_LINKER=riscv64-linux-gnu-gcc \
CC_riscv64gc_unknown_linux_gnu=riscv64-linux-gnu-gcc \
CXX_riscv64gc_unknown_linux_gnu=riscv64-linux-gnu-g++ \
AR_riscv64gc_unknown_linux_gnu=riscv64-linux-gnu-ar \
cargo build --offline --locked --release \
  --manifest-path apps/zcode-cli-rust/Cargo.toml \
  --bin zcode-cli-rust --target riscv64gc-unknown-linux-gnu --jobs 4
```

本机全量目标首次编译耗时约 2 分 46 秒。该值是编译耗时，**不是 CLI 启动/运行性能**。`ring 0.17.14`、bundled `libsqlite3-sys 0.35.0` / `rusqlite 0.37.0`、`rustls 0.23.45`、`reqwest 0.13.5` 均参与实际目标构建。

## 产物静态信息

路径（被 Git 忽略，不纳入提交）：

`apps/zcode-cli-rust/target/riscv64gc-unknown-linux-gnu/release/zcode-cli-rust`

| 项目           | 观测值                                                             |
| -------------- | ------------------------------------------------------------------ |
| 文件           | ELF64 little-endian PIE，RISC-V，stripped                          |
| ABI            | RVC、double-float / lp64d                                          |
| 大小           | 35,758,416 bytes（约 34.1 MiB）                                    |
| SHA-256        | `2e352992daebdeeccb7b3f77f0e5b68a2cf72757e3551605dabea9c053b32023` |
| interpreter    | `/lib/ld-linux-riscv64-lp64d.so.1`                                 |
| 动态依赖       | libgcc_s.so.1、libm.so.6、libc.so.6、ld-linux-riscv64-lp64d.so.1   |
| GLIBC 符号版本 | 最高引用 GLIBC_2.34；目标环境至少需满足该符号要求                  |

`readelf -A` 观测 ISA 属性：

```text
rv64i2p1_m2p0_a2p1_f2p2_d2p2_c2p0_zicsr2p0_zifencei2p0_zmmul1p0_zaamo1p0_zalrsc1p0_zca1p0_zcd1p0
```

核查使用 `file`、`stat`、`sha256sum`、`riscv64-linux-gnu-readelf -h/-A/-l/-d/--version-info`，没有用执行程序的方式探测动态库。

## 未验收

- 真机或模拟器的启动、stdio、存储迁移/历史读取、TLS、取消/进程树清理。
- RISC-V 发行版所需 bash/procps/procfs、证书及 glibc/loader 的实际兼容性。
- ring 通用实现等非 x86/ARM 路径的功能、安全与性能验证。
- 远端 Node zcode-server、node-pty、搜索工具、插件资产及远端 manifest 的 RISC-V 扩展。目前远端资产仍限定 Linux x64，桌面 Rust 的 target 表也尚无 RISC-V。

本机原始日志在 `/tmp/zcode-riscv64-probe/`，为临时运行记录，不是版本库持久证据。复现以以上命令、源码 commit、锁文件及产物身份为准。
