# syntax=docker/dockerfile:1
FROM golang:1.27.3-alpine AS build

# 国内 VPS 构建时默认走 Go 模块代理，避免 proxy.golang.org 超时。
# 需要官方源时：docker compose build --build-arg GOPROXY=https://proxy.golang.org,direct
ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=${GOPROXY}

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags='-s -w -buildid=' \
    -o /out/classroom-notice \
    ./cmd/server

FROM alpine:3.22

RUN apk add --no-cache ca-certificates tzdata wget \
    && addgroup -S classroom \
    && adduser -S -G classroom classroom \
    && mkdir -p /data \
    && chown classroom:classroom /data

COPY --from=build /out/classroom-notice /app/classroom-notice

USER classroom
WORKDIR /app
ENV APP_MODE=production \
    HTTP_ADDR=0.0.0.0:8080 \
    DATABASE_PATH=/data/notice.db \
    TZ=Asia/Shanghai

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["/app/classroom-notice"]
