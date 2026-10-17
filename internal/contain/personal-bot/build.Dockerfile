ARG GO_VERSION
FROM golang:${GO_VERSION}-bookworm AS builder
ARG TARGETARCH
ARG TERM_LLM_VERSION
ARG TERM_LLM_COMMIT
ARG TERM_LLM_DATE
WORKDIR /src
ADD source.tar.gz ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -trimpath \
    -ldflags "-s -w -X github.com/samsaffron/term-llm/cmd.Version=$TERM_LLM_VERSION -X github.com/samsaffron/term-llm/cmd.Commit=$TERM_LLM_COMMIT -X github.com/samsaffron/term-llm/cmd.Date=$TERM_LLM_DATE" \
    -o /out/term-llm .
