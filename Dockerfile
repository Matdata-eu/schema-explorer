# syntax=docker/dockerfile:1

# Build stage: the WebAssembly parser and the web viewer, then the release
# binary with the viewer embedded. The binary is all the runtime image needs.
FROM rust:1-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
# wasm-bindgen-cli must match the wasm-bindgen crate in Cargo.lock.
RUN V=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | sed -n 's/^version = "\(.*\)"/\1/p') \
    && cargo install wasm-bindgen-cli --version "$V" --locked
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY crates crates
COPY web web
COPY THIRD_PARTY_NOTICES.md README.md ./
RUN cd web && npm run build
RUN cargo build --release --locked -p schema-explorer

# Runtime stage: glibc and nothing else, running as an unprivileged user.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/schema-explorer /usr/local/bin/schema-explorer
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/schema-explorer/

# Serve the viewer on port 8080. Every SCHEMA_EXPLORER_* variable maps to a
# `serve` flag; see the README. Mount your files in /data and pass them as
# arguments, e.g.  docker run -v $PWD:/data -p 8080:8080 IMAGE serve --no-open schema.xsd
ENV SCHEMA_EXPLORER_BIND=0.0.0.0:8080
EXPOSE 8080
WORKDIR /data
ENTRYPOINT ["schema-explorer"]
CMD ["serve", "--no-open"]
