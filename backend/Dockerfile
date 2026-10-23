# syntax=docker/dockerfile:1
# 多阶段构建：Rust 编译 → 最小运行时镜像。最终镜像约 90MB，无编译工具链。
FROM rust:1.93-slim-bookworm AS builder
WORKDIR /app

# 依赖层缓存：先用空 main 编译全部依赖，源码改动时不必重编依赖。
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src \
    && printf 'fn main() {}\n' > src/main.rs \
    && touch src/lib.rs \
    && cargo build --release --locked \
    && rm -rf src target/release/ip-please-sync.d \
       target/release/deps/ip_please_sync-* target/release/deps/libip_please_sync-*

COPY src ./src
COPY migrations ./migrations
RUN touch src/main.rs src/lib.rs && cargo build --release --locked

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/ip-please-sync /usr/local/bin/ip-please-sync

USER 65534:65534
EXPOSE 8080
ENV BIND_ADDR=0.0.0.0:8080 \
    RUST_LOG=info,sqlx=warn

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/anthropic/v1/health || exit 1

ENTRYPOINT ["/usr/local/bin/ip-please-sync"]
