// Estilos de la suite (Tailwind 3.4.17), compilados a public/tw.css.
// Antes se cargaban desde cdn.tailwindcss.com en el navegador; algunos
// celulares (bloqueadores, ahorro de datos) no lo cargaban y la suite se veía
// sin diseño. Ahora el archivo sale del mismo servidor.
// Se recompila solo al publicar (Dockerfile). A mano:
//   npx tailwindcss@3.4.17 -c tailwind.config.js -i src/styles/tailwind.css -o public/tw.css --minify
module.exports = {
  // public/vendor (librerías de terceros) no se revisa: no tiene clases de la suite.
  content: ['./public/**/*.html', './public/*.js'],
  theme: { extend: {} },
  plugins: [],
};
