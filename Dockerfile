FROM node:22-slim

# ffmpeg (fusion audio/vidéo) + yt-dlp (import YouTube/Twitch) + deno (requis par yt-dlp pour YouTube)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp
RUN curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
 && unzip /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip && chmod +x /usr/local/bin/deno

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV PORT=3000
EXPOSE 3000
# yt-dlp est mis à jour à chaque démarrage (YouTube change souvent)
CMD ["sh", "-c", "yt-dlp -U >/dev/null 2>&1 || true; node server.js"]
