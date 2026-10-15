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

# Estilos de la suite (Tailwind): se compilan aqui para que siempre incluyan
# todas las clases usadas en las paginas. Si no hay conexion para descargar
# el compilador, se usa el public/tw.css que ya viene en el repositorio.
RUN npx --yes tailwindcss@3.4.17 -c tailwind.config.js -i src/styles/tailwind.css -o public/tw.css --minify \
    || echo "Aviso: no se pudo compilar Tailwind; se usa public/tw.css del repositorio"

# Copia la configuracion de Litestream y el script de arranque
COPY litestream.yml /etc/litestream.yml
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
