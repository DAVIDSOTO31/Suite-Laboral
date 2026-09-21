#!/bin/sh
set -e

mkdir -p /app/data

# Si al arrancar el contenedor no existe la base de datos local (por ejemplo
# porque Render borro el disco al reiniciar), la restauramos desde la nube.
if [ ! -f /app/data/app.db ]; then
  echo ">> No hay base de datos local. Intentando restaurar desde la nube..."
  litestream restore -if-replica-exists -config /etc/litestream.yml /app/data/app.db
  echo ">> Restauracion completada (o no habia backup previo: se creara uno nuevo)."
fi

# A partir de aqui, litestream queda vigilando la base de datos y copiando
# cada cambio a la nube casi en tiempo real, mientras corre tu app normal.
exec litestream replicate -config /etc/litestream.yml -exec "node src/server.js"
