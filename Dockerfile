FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.mjs player.html direct-player.html mjpeg-player.html ./
ENV PORT=8788
EXPOSE 8788
CMD ["node", "server.mjs"]
