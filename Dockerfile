FROM node:22-slim

# Install curl-impersonate dependencies + download binary
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates wget libnss3 libnghttp2-14 && \
    wget -q https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz && \
    mkdir -p /opt/curl-imp && \
    tar xzf curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz -C /opt/curl-imp && \
    rm curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz && \
    chmod +x /opt/curl-imp/curl_* 2>/dev/null; \
    apt-get remove -y wget && apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

ENV LD_LIBRARY_PATH=/opt/curl-imp
ENV PATH="/opt/curl-imp:${PATH}"

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
