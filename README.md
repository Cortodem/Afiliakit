# Afiliakit — Plantilla web de afiliados para lanzar sitios rápidos, profesionales y listos para vender

Afiliakit es una plantilla estática y modular para crear páginas de afiliación con un enfoque claro: claridad comercial, SEO sólido, conversión y respeto por la privacidad. Está pensada para que puedas reutilizar la misma base muchas veces, cambiando solo los textos, enlaces y productos.

La idea no es crear un único sitio, sino una máquina de publicación: una estructura reutilizable para lanzar micrositios en nichos distintos, adaptar branding y mantener una experiencia premium sin depender de frameworks ni de procesos complejos.

## Qué hace esta plantilla

- Sitio de afiliados con home y páginas de categoría
- Estructura SEO amigable con metadatos y OG/Twitter
- Catálogo de productos centralizado en JSON
- Diseño responsivo para móvil y desktop
- Banner de cookies con consentimiento previo
- Enlaces externos con `target="_blank" rel="sponsored nofollow"`
- Sin dependencias pesadas ni compilación
- Listo para desplegar en cualquier hosting estático

## Por qué esta idea funciona

La clave está en dividir el sitio en piezas claras:

- Configuración global: nombres, textos, colores y etiquetas
- Datos de productos: imagen, precio, slug, categoría y URL de afiliado
- Plantilla dinámica: una misma base sirve para múltiples categorías
- Contenido legal: avisos, privacidad y cookies gestionados por separado

Esto te permite escalar sin duplicar trabajo: en lugar de crear una web desde cero cada vez, solo reutilizas la estructura y cambias el contenido del negocio.

## Estructura del proyecto

```text
.
├── index.html
├── categoria.html
├── config.json
├── data/
│   └── products.json
├── assets/
│   ├── css/
│   └── js/
│       ├── app.js
│       └── cookies.js
├── avisos-legales.html
├── politica-privacidad.html
├── politica-cookies.html
├── textos/
├── docs/
├── specs/
├── LICENSE
├── MEMORY.md
├── AGENTS.md
└── README.md
```

## Cómo personalizarla tantas veces como quieras

### 1) Haz una copia del proyecto

Puedes duplicar la carpeta tantas veces como necesites. Cada nueva web puede ser una versión distinta del mismo sistema.

Ejemplo:

- `sitio-nutricion`
- `sitio-marketing`
- `sitio-productividad`
- `sitio-curso-online`

Cada copia puede tener su propia marca, color, catálogo y contenido.

### 2) Ajusta la configuración global

Edita `config.json` y define:

- nombre del sitio
- tagline
- URL base
- email de contacto
- colores del tema
- textos de CTA, botón, banners y footer
- categorías principales

Ejemplo de configuración:

```json
{
  "site": {
    "name": "Mi Marca",
    "tagline": "Productos que ayudan a crecer tu negocio",
    "defaultCategory": "marketing-digital",
    "baseUrl": "https://www.tumarca.com",
    "contactEmail": "hola@tumarca.com"
  },
  "theme": {
    "primary": "#6d5efc",
    "secondary": "#20c997",
    "bg": "#0b1020"
  }
}
```

### 3) Define tus categorías

En `config.json` también configuras las categorías visibles en la navegación y en la home. Cada categoría debe tener:

- `slug`
- `name`
- `title`
- `description`
- `featuredImage`

Importante: el `slug` debe coincidir con el valor usado en el catálogo de productos y con la navegación. Si no lo haces bien, la categoría no se mostrará correctamente.

### 4) Rellena tu catálogo de productos

Edita `data/products.json` y añade todos los productos de afiliación. Para cada producto incluye:

- `id`
- `name`
- `slug`
- `category`
- `price`
- `currency`
- `image`
- `affiliateUrl`
- `shortDescription`
- `badge`

Ejemplo:

```json
{
  "id": "mi-producto",
  "name": "Mi Producto",
  "slug": "mi-producto",
  "category": "marketing-digital",
  "price": 49,
  "currency": "EUR",
  "image": "https://images.unsplash.com/...",
  "affiliateUrl": "https://tuafiliado.com/mi-producto",
  "shortDescription": "Solución para automatizar y mejorar resultados.",
  "badge": "Top seller"
}
```

### 5) Reemplaza los enlaces de afiliado

Todos los enlaces externos a productos deben apuntar a tu enlace de afiliado, y en la plantilla se utilizan con la estructura correcta para comercio afiliado:

```html
<a href="https://tuafiliado.com/..." target="_blank" rel="sponsored nofollow">Ver oferta</a>
```

Esto evita problemas de SEO y mantiene una práctica segura y transparente.

### 6) Personaliza el contenido del sitio

Puedes cambiar:

- hero de la home
- textos de categorías
- mensaje de cookies
- footer y enlaces legales
- etiquetas de botones y estados
- cualquier texto visible en la web

La idea es que la plantilla sea fácilmente reutilizable, sin tocar mucho el código.

### 7) Gestiona el contenido largo por categoría

Si quieres añadir contenido editorial más completo a cada categoría, puedes usar el sistema de textos en `textos/categorias/` o ajustar la lógica según tu estrategia de contenido.

### 8) Publica en hosting estático

La plantilla funciona perfectamente en cualquier servicio estático:

- GitHub Pages
- Netlify
- Vercel
- Cloudflare Pages
- hosting tradicional de archivos

No necesitas backend ni base de datos.

## Cómo arrancarla localmente

Desde la raíz del proyecto ejecuta:

```bash
python -m http.server 8000
```

Luego abre en el navegador:

```text
http://localhost:8000
```

Puedes comprobar:

- la home principal
- las páginas de categoría con `?slug=...`
- el banner de cookies
- el comportamiento responsive

## Recomendaciones para vender más con esta plantilla

- Mantén el diseño limpio y profesional
- Usa títulos concretos y orientados a beneficio
- Elige un nicho claro y específico
- Añade comparativas cortas y llamadas a la acción visibles
- Mantén una estructura de categorías muy clara
- Revisa que cada enlace de afiliado sea real y relevante
- Activa el banner de cookies sin cargar analítica antes del consentimiento

## Buenas prácticas del proyecto

- Mantén `config.json` como origen de verdad del branding
- No hardcodees textos en HTML si ya están en configuración
- Haz coincidir slugs entre config y productos
- No cargues seguimiento ni scripts analíticos sin consentimiento
- Usa enlaces de afiliado transparentes y bien etiquetados
- Haz cambios pequeños y seguros en una base reutilizable

## Ventaja real de esta plantilla

Este proyecto no es solo un diseño bonito. Es una base de crecimiento:

- permite lanzar varios sitios con una lógica común
- reduce tiempo de desarrollo
- facilita mantenimiento
- evita depender de un CMS pesado
- mantiene la web enfocada en conversión y SEO

En resumen: puedes reutilizar esta idea tantas veces como quieras, cambiando solo la marca, el producto y el nicho.

## Siguiente paso

Si quieres convertir esta base en una web real, lo ideal es:

1. renombrar la plantilla al negocio que vas a vender
2. personalizar `config.json`
3. cargar productos reales
4. ajustar textos legales y CTA
5. publicar en un hosting estático
6. medir clics, conversiones y rendimiento

La plantilla está preparada para empezar, y tú eres el responsable de darle la identidad final.

## Licencia

Afiliakit se distribuye bajo la licencia MIT. Consulta el archivo [LICENSE](./LICENSE) para ver los términos completos.

---

Hecho para lanzar muchas versiones del mismo concepto: una web de afiliados profesional, escalable y enfocada en vender.
