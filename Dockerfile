# Imagen oficial de Litestream: de aqui tomamos el programa ya compilado,
# sin necesidad de descargarlo manualmente (mucho mas confiable).
FROM litestream/litestream:0.5.17 AS litestream

# Imagen base con Node.js 22 (la version que ya requiere el proyecto)
FROM node:22-slim

# Copiamos el programa litestream desde la imagen oficial
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream

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
