# Imagen base con Node.js 22 (la version que ya requiere el proyecto)
FROM node:22-slim

# Instala curl y tar para poder descargar Litestream
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*

# Descarga Litestream (version fija y estable, sin depender de la API de GitHub)
RUN curl -fsSL -o /tmp/litestream.tar.gz \
    https://github.com/benbjohnson/litestream/releases/download/v0.5.17/litestream-v0.5.17-linux-amd64.tar.gz \
    && tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz litestream \
    && rm /tmp/litestream.tar.gz
WORKDIR /app

# Copia el proyecto (package.json no tiene dependencias externas, pero se
# respeta el flujo normal de instalacion por si en el futuro se agregan)
COPY package.json ./
RUN npm install --omit=dev || true
COPY . .

# Copia la configuracion de Litestream y el script de arranque
COPY litestream.yml /etc/litestream.yml
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
