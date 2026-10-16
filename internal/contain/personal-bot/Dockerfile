FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bash git curl ripgrep gosu \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home --shell /bin/bash agent
COPY term-llm /usr/local/bin/term-llm
RUN chmod 755 /usr/local/bin/term-llm
WORKDIR /workspace
