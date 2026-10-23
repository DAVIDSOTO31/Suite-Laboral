# Librerías de terceros (servidas por la propia suite)

Antes se descargaban de cdn.jsdelivr.net al abrir la suite. Ahora salen del mismo
servidor, así los gráficos, los PDF, las imágenes y los Excel funcionan aunque ese
sitio esté caído o bloqueado. El nombre de cada archivo lleva la versión: para
actualizar una librería se agrega el archivo nuevo y se cambia la ruta en app.html.

| Archivo | Librería | Versión | Licencia | Uso en la suite |
|---|---|---|---|---|
| chart-4.4.4.umd.js | Chart.js | 4.4.4 | MIT | Gráficos del Tablero Gerencial |
| jspdf-2.5.1.umd.min.js | jsPDF | 2.5.1 | MIT | PDF (cierres, colillas, indicadores, cuadro de turnos) |
| html2canvas-1.4.1.min.js | html2canvas | 1.4.1 | MIT | PDF e imagen del cuadro de turnos |
| xlsx-0.18.5.full.min.js | SheetJS (xlsx) | 0.18.5 | Apache-2.0 | Archivos Excel |
| face-api-1.7.15/ (face-api.js + 3 modelos) | @vladmandic/face-api | 1.7.15 | MIT | Reconocimiento facial (kiosco y Biometría). Modelos: detector de rostro, puntos de la cara y plantilla de 128 números. Si fallan, la suite usa el sitio externo de antes como respaldo. |
