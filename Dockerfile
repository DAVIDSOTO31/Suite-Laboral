# Imagen base con Node.js 22 (la version que ya requiere el proyecto)
FROM node:22-slim

# Instala curl y tar para poder descargar Litestream
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*

# Descarga la ultima version de Litestream (herramienta que copia la base de
# datos SQLite hacia la nube en tiempo real) sin fijar un numero de version
RUN curl -fsSL https://api.github.com/repos/benbjohnson/litestream/releases/latest \
    | grep "browser_download_url.*linux-amd64.tar.gz" \
    | cut -d '"' -f 4 \
    | xargs -I {} curl -fsSL {} -o /tmp/litestream.tar.gz \
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
