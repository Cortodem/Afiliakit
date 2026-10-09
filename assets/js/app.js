const DATA_SOURCES = {
  config: 'config.json',
  catalog: 'data/products.json'
};

const RETRY_DELAYS = [1000, 3000];

// Categoria reservada de la que salen los candidatos al bloque de destacados y tope de fichas del
// bloque. Son constantes del dominio, no configurables: el criterio de negocio D1 es aleatorio y
// el bloque muestra como máximo dos productos.
const FEATURED_CATEGORY = 'destacados';
const FEATURED_LIMIT = 2;

const dataFlows = {
  config: { status: 'idle', data: null, error: null },
  catalog: { status: 'idle', data: null, error: null }
};

const siteState = {
  config: null,
  products: [],
  discarded: [],
  categoryText: null,
  validation: { mode: 'idle', categoryChecked: false, note: '' }
};

const discardState = {
  entries: [],
  reported: false
};

// Seleccion de destacados ya resuelta para la carga en curso. Es null mientras no se ha elegido
// nada: en cuanto se elige, se reutiliza en todos los repintados de la misma carga, de modo que el
// bloque no cambia al navegar entre categorías (R3).
const featuredState = {
  selection: null
};

// Página activa. La necesita la acción de reinicio: el mismo botón aparece en la portada y en la de
// categoría, y cada una tiene su contenedor de estado y su lógica de pintado, así que al terminar la
// recarga hay que saber cuál de las dos repintar. La fija el arranque de cada página y no cambia con
// la navegación, que T12 todavía no mueve sin recarga.
const viewState = {
  page: 'home'
};

// Reinicio en curso. Bloquea un segundo reinicio mientras el primero sigue agotando sus intentos:
// sin este guardia, dos clics seguidos lanzarían dos cargas completas del sitio y la vista podría
// quedar pintada con los datos de una y luego con los de la otra.
const retryState = {
  running: false
};

const DISCARD_REASONS = {
  name: 'Falta el nombre del producto',
  affiliateUrl: 'Falta el enlace de afiliado',
  missingCategory: 'Falta la categoría del producto',
  unknownCategory: 'La categoría no existe en la configuración',
  missingCategorySlug: 'La categoría no declara identificador (slug) y no se publica',
  duplicateSlug: 'Identificador de categoría duplicado: se conserva la primera declaración'
};

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function loadJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Error loading ${url}`);
  }
  return response.json();
}

async function loadJsonWithRetry(url, delays = RETRY_DELAYS) {
  const waitTimes = Array.isArray(delays) ? delays : [];
  let lastError = null;

  for (let attempt = 0; attempt <= waitTimes.length; attempt += 1) {
    if (attempt > 0) {
      await wait(waitTimes[attempt - 1]);
    }

    try {
      return await loadJson(url);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function loadCategoryText(slug) {
  // Un slug vacío no identifica ningún texto: sin esta guarda la URL resultante sería
  // `textos/categorias/.md` y la petición devolvía un 404 evitable en cada portada. Los slugs no
  // vacíos sí se piden aunque no exista el fichero, porque el texto largo es contenido opcional
  // (spec 002) y su 404 es el comportamiento esperado.
  const textSlug = readText(slug);
  if (!textSlug) return null;

  const url = `textos/categorias/${textSlug}.md`;
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    const text = await response.text();
    if (typeof text !== 'string' || text.trim() === '') {
      // R2: el fichero existe pero no aporta nada (vacío o solo blancos). Se trata como texto
      // ausente y el único aviso posible es este de consola: en pantalla no se muestra nada.
      console.warn(`Category text at ${url} is empty; it is treated as missing.`);
      return null;
    }
    return text;
  } catch (error) {
    console.error(`Error loading category text from ${url}:`, error);
    return null;
  }
}

// R5, R16, R17: clasifica la URL de un enlace markdown antes de emitirla. Devuelve 'external'
// para http(s) y rutas protocolo-relativas (que llevan target="_blank" rel="sponsored nofollow"
// por la constitución), 'direct' para mailto/tel, 'relative' para rutas internas y null cuando
// el esquema es peligroso (javascript:, data:, vbscript:) o la URL está vacía: en ese caso no se
// crea ningún enlace y la sintaxis completa se muestra como texto literal, porque escapar el
// href no basta para neutralizar un esquema ejecutable.
function classifyCategoryLinkUrl(url) {
  const value = readText(url);
  if (!value) return null;

  const scheme = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name === 'http' || name === 'https') return 'external';
    if (name === 'mailto' || name === 'tel') return 'direct';
    return null;
  }

  if (value.startsWith('//')) return 'external';
  return 'relative';
}

// R5, R16, R17: render inline limitado. Recorre el texto crudo carácter a carácter: cada tramo
// literal pasa por escapeHtml y solo se generan las etiquetas soportadas (code, a, strong, em).
// Toda la sintaxis no reconocida (imágenes ![](), HTML crudo, scripts) queda como texto escapado
// y jamás se interpreta. El escapado ocurre antes de cualquier inserción en el marcado: es el
// único camino que recorre el dato proveniente del markdown.
function renderMarkdownInline(raw) {
  let html = '';
  let literal = '';
  let index = 0;

  const flushLiteral = () => {
    if (literal !== '') {
      html += escapeHtml(literal);
      literal = '';
    }
  };

  while (index < raw.length) {
    const char = raw[index];

    // Código inline `...`: su contenido se escapa y no participa en ningún otro transform.
    if (char === '`') {
      const end = raw.indexOf('`', index + 1);
      if (end > index + 1) {
        flushLiteral();
        html += `<code>${escapeHtml(raw.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
      literal += char;
      index += 1;
      continue;
    }

    // Imagen ![texto](url): sintaxis no soportada, se muestra literal sin interpretarse (R5).
    if (char === '!' && raw[index + 1] === '[') {
      const image = /^!\[[^\]]*\]\([^)]*\)/.exec(raw.slice(index));
      if (image) {
        flushLiteral();
        html += escapeHtml(image[0]);
        index += image[0].length;
        continue;
      }
      literal += char;
      index += 1;
      continue;
    }

    // Enlace [texto](url): href y texto pasan por escapeHtml; los externos abren pestaña nueva.
    if (char === '[') {
      const link = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(raw.slice(index));
      if (link) {
        const kind = classifyCategoryLinkUrl(link[2]);
        flushLiteral();
        if (kind) {
          const attrs = kind === 'external' ? ' target="_blank" rel="sponsored nofollow"' : '';
          html += `<a href="${escapeHtml(readText(link[2]))}"${attrs}>${renderMarkdownInline(link[1])}</a>`;
        } else {
          // URL vacía o de esquema no permitido: la sintaxis entera queda como texto literal.
          html += escapeHtml(link[0]);
        }
        index += link[0].length;
        continue;
      }
      literal += char;
      index += 1;
      continue;
    }

    // Negrita **...**. Se comprueba antes que la cursiva simple para no consumir un solo asterisco.
    if (char === '*' && raw[index + 1] === '*') {
      const end = raw.indexOf('**', index + 2);
      if (end > index + 2) {
        flushLiteral();
        html += `<strong>${renderMarkdownInline(raw.slice(index + 2, end))}</strong>`;
        index = end + 2;
        continue;
      }
      literal += char;
      index += 1;
      continue;
    }

    // Cursiva *...*: la apertura debe ir seguida de texto y el cierre precedido de texto, para
    // no convertir espacios o `**` sueltos en énfasis.
    if (char === '*') {
      const next = raw[index + 1];
      let end = -1;
      if (next !== undefined && next !== ' ' && next !== '\t') {
        for (let cursor = index + 1; cursor < raw.length; cursor += 1) {
          if (raw[cursor] !== '*') continue;
          const before = raw[cursor - 1];
          const after = raw[cursor + 1];
          if (before === ' ' || before === '\t' || before === '*' || after === '*') continue;
          end = cursor;
          break;
        }
      }
      if (end > index + 1) {
        flushLiteral();
        html += `<em>${renderMarkdownInline(raw.slice(index + 1, end))}</em>`;
        index = end + 1;
        continue;
      }
      literal += char;
      index += 1;
      continue;
    }

    // Cursiva _..._: solo abre tras un límite de palabra (snake_case no se interpreta).
    if (char === '_') {
      const prev = index > 0 ? raw[index - 1] : '';
      const next = raw[index + 1];
      const canOpen =
        next !== undefined &&
        next !== ' ' &&
        next !== '\t' &&
        next !== '_' &&
        (index === 0 || !/[A-Za-z0-9]/.test(prev));
      let end = -1;
      if (canOpen) {
        for (let cursor = index + 1; cursor < raw.length; cursor += 1) {
          if (raw[cursor] !== '_') continue;
          const before = raw[cursor - 1];
          const after = raw[cursor + 1];
          if (before === ' ' || before === '\t' || before === '_') continue;
          if (after !== undefined && /[A-Za-z0-9]/.test(after)) continue;
          end = cursor;
          break;
        }
      }
      if (end > index + 1) {
        flushLiteral();
        html += `<em>${renderMarkdownInline(raw.slice(index + 1, end))}</em>`;
        index = end + 1;
        continue;
      }
      literal += char;
      index += 1;
      continue;
    }

    literal += char;
    index += 1;
  }

  flushLiteral();
  return html;
}

// R2, R4, R5, R16, R17: markdown limitado del texto de categoría a HTML. Solo se interpretan
// encabezados (# a ######), párrafos, listas, citas, bloques de código cercados y los elementos
// inline de renderMarkdownInline; cualquier otra sintaxis (imágenes, tablas, HTML crudo,
// footnotes) se escapa y se muestra como texto literal sin ejecutarse nunca. Devuelve
// { html, isValid }: isValid aplica R2 con R4 y el criterio A3, es decir el texto solo se
// considera válido si contiene (a) un encabezado principal #, (b) al menos un subtítulo ## y
// (c) al menos un párrafo de cuerpo; si falta cualquiera de los tres, isValid es false y el
// llamante debe tratar el texto como inexistente (R2: sin aviso en pantalla, como mucho un
// aviso en consola). El html se calcula igualmente aunque isValid sea false: quien decide
// ignorarlo es el llamante (R2). El texto es dato no confiable: todo fragmento proveniente
// del crudo pasa por escapeHtml antes de entrar en el marcado.
function parseCategoryText(rawText) {
  if (typeof rawText !== 'string') return { html: '', isValid: false };

  const lines = rawText.split(/\r\n|\r|\n/);
  const blocks = [];
  // R2 + R4 + A3: se detectan por separado encabezado principal (#), subtítulo (##) y
  // cuerpo, porque R4 exige las tres piezas y manda aplicar R2 a los textos incompletos.
  // No hay requisito de posición: basta con que # y ## aparezcan en el documento, porque
  // R2 habla de «contener». #texto o ##texto sin espacio no son encabezados y no cuentan.
  let hasH1 = false;
  let hasH2 = false;
  let bodyParagraphs = 0;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // Bloque de código cercado por ``` ... ```: contenido literal, que es el contexto que T3
    // necesita para no sustituir marcadores dentro de código (A12).
    if (/^\s*```/.test(line)) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    // Encabezados # .. ###### (se exige espacio o fin de línea: #texto es párrafo literal).
    // Solo los niveles 1 y 2 exactos suman para isValid: un ### o un ###### no satisface
    // ni el # ni el ## que exige R4 (R4 manda aplicar R2: texto inexistente, criterio A3).
    const heading = /^(#{1,6})(?:\s+(.*))?$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (level === 1) hasH1 = true;
      else if (level === 2) hasH2 = true;
      blocks.push(`<h${level}>${renderMarkdownInline(heading[2] || '')}</h${level}>`);
      index += 1;
      continue;
    }

    // Cita > ...: las líneas consecutivas se agrupan en un solo blockquote.
    if (line[0] === '>') {
      const quoted = [];
      while (index < lines.length && lines[index][0] === '>') {
        quoted.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      const inner = quoted
        .filter((quotedLine) => quotedLine.trim() !== '')
        .map((quotedLine) => `<p>${renderMarkdownInline(quotedLine.trim())}</p>`)
        .join('');
      blocks.push(`<blockquote>${inner}</blockquote>`);
      continue;
    }

    // Listas: - * + (desordenadas) y 1. / 1) (ordenadas), en tramos consecutivos del mismo tipo.
    const unorderedItem = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    const orderedItem = unorderedItem ? null : /^\s{0,3}\d+[.)]\s+(.*)$/.exec(line);

    if (unorderedItem || orderedItem) {
      const isOrdered = Boolean(orderedItem);
      const pattern = isOrdered ? /^\s{0,3}\d+[.)]\s+(.*)$/ : /^\s{0,3}[-*+]\s+(.*)$/;
      const items = [];
      while (index < lines.length) {
        const item = pattern.exec(lines[index]);
        if (!item) break;
        items.push(`<li>${renderMarkdownInline(item[1])}</li>`);
        index += 1;
      }
      blocks.push(isOrdered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    // Párrafo: tramo de líneas que no abre ningún otro bloque; las líneas suaves se unen con
    // un espacio, igual que en markdown. Solo los párrafos de nivel superior cuentan como
    // cuerpo para isValid (una cita o un elemento de lista no lo son).
    const paragraph = [];
    while (index < lines.length) {
      const current = lines[index];
      if (current.trim() === '') break;
      if (/^(#{1,6})(\s|$)/.test(current)) break;
      if (/^\s*```/.test(current)) break;
      if (current[0] === '>') break;
      if (/^\s{0,3}[-*+]\s+/.test(current)) break;
      if (/^\s{0,3}\d+[.)]\s+/.test(current)) break;
      paragraph.push(current.trim());
      index += 1;
    }

    if (paragraph.length > 0) {
      bodyParagraphs += 1;
      blocks.push(`<p>${renderMarkdownInline(paragraph.join(' '))}</p>`);
    }
  }

  return {
    html: blocks.join('\n'),
    // R2 + R4 + A3: el texto solo es válido con # y ## y al menos un párrafo de cuerpo.
    // Si falta cualquiera de los tres, isValid es false (se trata como inexistente), pero
    // el html devuelto no cambia: se calcula igual y es el llamante quien lo ignora (R2).
    isValid: hasH1 && hasH2 && bodyParagraphs > 0
  };
}

// R7, R8, R10, R11: sustituye cada marcador `[producto]` del html devuelto por
// parseCategoryText por la ficha buildProductCard del siguiente producto publicable, en orden
// de aparición y en el orden del catálogo (R7). Función pura: no toca el DOM ni muta los
// argumentos; el llamante (T6) le pasa el html y los productos de la categoría y decide dónde
// colocar el resultado.
// - R8: cuando los productos se agotan, el marcador sobrante se consume sin escribir nada (sin
//   hueco, mensaje ni error); sin productos se eliminan todos los marcadores de texto.
// - R11: el `[producto]` solo es marcador fuera de código y citas. El html se recorre etiqueta
//   a etiqueta manteniendo la profundidad de <code>, <pre> y <blockquote>, y dentro de esos
//   ancestros el texto se copia literal. Un criterio "solo <p>" no bastaría: la cita envuelve su
//   propio <p>, así que el marcador parecería de párrafo y habría que excluirlo por ancestro.
// - R10: las fichas se concatenan tal cual salen de buildProductCard (escapado y atributos de
//   accesibilidad intactos). El html de entrada ya viene escapado de parseCategoryText, así que
//   aquí no se vuelve a escapar nada: duplicar el escapado rompería el marcado de las fichas.
function injectProductMarkers(html, products) {
  const source = typeof html === 'string' ? html : '';
  const list = Array.isArray(products) ? products : [];
  const marker = '[producto]';
  const tagPattern = /<\/?[a-zA-Z][^>]*>/g;
  let output = '';
  let cursor = 0;
  let next = 0;
  let blocked = 0;
  let dropped = 0;

  // Tramo de texto entre dos etiquetas. Si el tramo cae dentro de código o cita se copia
  // literal (R11) y no consume productos; si no, cada marcador toma el siguiente producto y,
  // si ya no queda ninguno, se elimina sin dejar rastro (R8).
  const emitText = (text) => {
    if (!text) return;
    if (blocked > 0) {
      output += text;
      return;
    }
    let from = 0;
    let at = text.indexOf(marker, from);
    while (at !== -1) {
      output += text.slice(from, at);
      if (next < list.length) {
        output += buildProductCard(list[next]);
        next += 1;
      } else {
        dropped += 1;
      }
      from = at + marker.length;
      at = text.indexOf(marker, from);
    }
    output += text.slice(from);
  };

  let match = tagPattern.exec(source);
  while (match) {
    emitText(source.slice(cursor, match.index));
    const tag = match[0];
    const nameMatch = /^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
    const tagName = nameMatch ? nameMatch[1].toLowerCase() : '';
    if (tagName === 'code' || tagName === 'pre' || tagName === 'blockquote') {
      if (tag[1] === '/') {
        if (blocked > 0) blocked -= 1;
      } else {
        blocked += 1;
      }
    }
    output += tag;
    cursor = match.index + tag.length;
    match = tagPattern.exec(source);
  }
  emitText(source.slice(cursor));

  // R8: un bloque que quedó vacío tras descartar marcadores (párrafo con su margen, encabezado
  // o <li> con su viñeta) sería un hueco visible. Solo se limpia cuando se descartó algún
  // marcador, para que el resto de llamadas devuelvan el html intacto. Las fichas inyectadas
  // no pueden vaciarse: su <h3> lleva el nombre y su <p> la descripción, ambas no vacías en un
  // producto publicable.
  if (dropped > 0) {
    output = output.replace(/<(p|h[1-6]|li)>\s*<\/\1>/g, '');
    // R8, A5: una lista cuyo único contenido eran marcadores descartados quedaría como
    // <ul></ul> u <ol></ol>, y esos contenedores vacíos conservan sus márgenes por defecto y
    // dejan un hueco visible bajo el texto. Se retiran también los envolvedores vacíos, por
    // niveles (una cita sin viñetas deja la lista vacía y la lista vacía deja la cita), sin
    // tocar nunca los que siguen con contenido.
    let previous;
    do {
      previous = output;
      output = output.replace(/<(ul|ol|blockquote)>\s*<\/\1>/g, '');
    } while (output !== previous);
  }

  return output;
}

function startDataFlow(name) {
  const url = DATA_SOURCES[name];
  const flow = dataFlows[name];

  flow.status = 'loading';
  flow.error = null;

  return loadJsonWithRetry(url, RETRY_DELAYS).then(
    (data) => {
      flow.status = 'ready';
      flow.data = data;
      flow.error = null;
      return flow;
    },
    (error) => {
      flow.status = 'error';
      flow.data = null;
      flow.error = error;
      console.error(
        `No se pudo cargar ${url} tras ${RETRY_DELAYS.length + 1} intentos. El resto del sitio sigue funcionando.`,
        error
      );
      return flow;
    }
  );
}

function startConfigFlow() {
  return startDataFlow('config');
}

function startCatalogFlow() {
  return startDataFlow('catalog');
}

function readText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

const PRICE_LOCALE = 'es-ES';

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;'
};

// R10, R29: punto de entrada único del escapador. Ningún dato de la configuración ni del catálogo
// se interpola en una plantilla sin pasar por aquí, porque el marcado se construye con innerHTML.
// Un dato ausente devuelve cadena vacía: nunca aparecen literales "undefined" ni "null" en pantalla.
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, (character) => HTML_ESCAPES[character]);
}

// R8, R25: importe con la moneda declarada por el propio producto, sin símbolo fijo en el código.
// Si falta el precio o falta la moneda devuelve cadena vacía, para que la ficha omita el bloque
// entero en lugar de dejar un hueco, un guion o un símbolo inventado. Una moneda que Intl no
// reconoce se trata igual que una ausente, porque no se publica un importe sin unidad. El idioma
// se fija a español, que es el de la interfaz, y no al del navegador, para que el catálogo se
// lea igual en cualquier visita.
function formatPrice(price, currency) {
  const amount = readOptionalNumber(price);
  const code = readText(currency).toUpperCase();

  if (amount === null || !code) return '';

  try {
    return new Intl.NumberFormat(PRICE_LOCALE, {
      style: 'currency',
      currency: code
    }).format(amount);
  } catch {
    return '';
  }
}

function resolveDefaultCategory(candidate, categories) {
  const slug = readText(candidate);
  const exists = slug && categories.some((category) => category.slug === slug);

  if (exists) return slug;
  return categories.length > 0 ? categories[0].slug : null;
}

// R18, R19, R20: resuelve el slug de categoría a mostrar basándose en la URL y la configuración.
// Reglas completas:
// - Si no hay slug proporcionado → mostrar categoría predeterminada (R18)
// - Si slug es desconocido/inválido → mostrar categoría predeterminada (R19)
// - Si la categoría predeterminada no existe → ya quedó resuelta por normalizeConfig
//   (defaultSlug ya apunta a la primera categoría si la predeterminada no existía) (R20)
// - Si no hay categorías → estado de disponibilidad (null)
function resolveCategorySlug(requestedSlug, config) {
  if (!config) return null;

  const { defaultSlug, categories, categoryIndex } = config;

  // Si no hay slug proporcionado, usar la categoría predeterminada (R18)
  if (!requestedSlug) {
    return defaultSlug;
  }

  // Si el slug es desconocido o no está en el índice de categorías conocidas,
  // usar la categoría predeterminada (R19)
  if (categoryIndex && !categoryIndex.has(requestedSlug)) {
    return defaultSlug;
  }

  // El slug solicitado es una categoría conocida: lo devolvemos tal como está.
  // La resolución de la categoría predeterminada ya quedó asegurada por
  // normalizeConfig, que garantiza que defaultSlug sea una categoría válida
  // (o la primera declarada si la original no existía) (R20).
  return requestedSlug;
}

// R12, R20, R28: deduplica por slug conservando la primera declaración, resuelve la
// predeterminada y compone el índice de categorías y el mapa de textos.
function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const declared = Array.isArray(source.categories) ? source.categories : [];
  const discarded = [];
  const categories = [];
  const categoryIndex = new Map();

  declared.forEach((entry, position) => {
    const candidate = entry && typeof entry === 'object' ? entry : {};
    const slug = readText(candidate.slug);

    if (!slug) {
      discarded.push({
        kind: 'category',
        id: `categoria en la posicion ${position + 1}`,
        slug: '',
        missing: ['slug'],
        reason: DISCARD_REASONS.missingCategorySlug
      });
      return;
    }

    if (categoryIndex.has(slug)) {
      discarded.push({
        kind: 'category',
        id: slug,
        slug,
        missing: ['slug'],
        reason: DISCARD_REASONS.duplicateSlug
      });
      return;
    }

    const name = readText(candidate.name) || slug;
    const category = {
      slug,
      name,
      title: readText(candidate.title) || name,
      description: readText(candidate.description),
      featuredImage: readText(candidate.featuredImage)
    };

    categoryIndex.set(slug, category);
    categories.push(category);
  });

  const site = source.site && typeof source.site === 'object' ? source.site : {};
  const globalTexts =
    source.globalTexts && typeof source.globalTexts === 'object' ? source.globalTexts : {};

  return {
    site,
    theme: source.theme,
    telemetry: source.telemetry,
    globalTexts,
    categories,
    categoryIndex,
    defaultSlug: resolveDefaultCategory(site.defaultCategory, categories),
    discarded
  };
}

// R9, R25: publicable solo si consta nombre, categoría y enlace de afiliado. La existencia de la
// categoría solo es exigible con el índice de la configuración: sin configuración cargada se
// comprueban el nombre, la declaración de categoría y el enlace, nunca la existencia, porque no
// hay dato con el que comprobarla (R24). El resto de campos son opcionales.
function normalizeProduct(raw, categoryIndex) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const hasCategoryIndex = categoryIndex instanceof Map;
  const missing = [];
  const reasons = [];

  const name = readText(source.name);
  if (!name) {
    missing.push('name');
    reasons.push(DISCARD_REASONS.name);
  }

  const category = readText(source.category);
  if (!category) {
    missing.push('category');
    reasons.push(DISCARD_REASONS.missingCategory);
  } else if (hasCategoryIndex && !categoryIndex.has(category)) {
    missing.push('category');
    reasons.push(`${DISCARD_REASONS.unknownCategory} (${category})`);
  }

  const affiliateUrl = readText(source.affiliateUrl);
  if (!affiliateUrl) {
    missing.push('affiliateUrl');
    reasons.push(DISCARD_REASONS.affiliateUrl);
  }

  if (missing.length > 0) {
    return { ok: false, product: null, missing, reasons };
  }

  const id = readText(source.id) || readText(source.slug);

  return {
    ok: true,
    product: {
      id,
      name,
      slug: readText(source.slug) || id,
      category,
      price: readOptionalNumber(source.price),
      currency: readText(source.currency),
      image: readText(source.image),
      imageWidth: readOptionalNumber(source.imageWidth),
      imageHeight: readOptionalNumber(source.imageHeight),
      shortDescription: readText(source.shortDescription),
      badge: readText(source.badge),
      affiliateUrl
    },
    missing: [],
    reasons: []
  };
}

function resetDiscarded() {
  discardState.entries = [];
  discardState.reported = false;
}

// Cada carga de datos vuelve a dejar la elección de destacados pendiente, igual que hace
// resetDiscarded con los avisos. Así el reinicio de T8 vuelve a elegir, porque ya hay datos nuevos,
// y dentro de una misma carga la elección solo se hace una vez (R3).
function resetFeatured() {
  featuredState.selection = null;
}

// R12, R17: navegación de categorías generada desde la configuración.
// Renderiza la navegación principal con entrada fija "Inicio" y enlaces a cada categoría.
// Si hay slugs duplicados, solo aparece la primera declaración (la normalización ya
// garantiza esto en categories, pero nos aseguramos aquí también).
// R17: la entrada "Inicio" lleva la señal visible y el anuncio accesible cuando ninguna
// categoría de la lista es la activa (portada, páginas legales o categoría resuelta a vacío),
// de modo que siempre haya exactamente un enlace marcado.
function renderCategoryNav(categories, activeSlug) {
  const seenSlugs = new Set();
  seenSlugs.add('home'); // La entrada de inicio siempre va primera

  const list = Array.isArray(categories) ? categories : [];
  const requested = readText(activeSlug);
  const categoryIsActive = list.some((category) => {
    const slug = readText(category && category.slug);
    return slug !== '' && slug === requested;
  });

  // Empezamos con el enlace de "Inicio", activo solo si ninguna categoría coincide.
  const homeAttrs = categoryIsActive ? '' : ' class="nav-active" aria-current="page"';
  let navHtml = `<a href="index.html"${homeAttrs}>Inicio</a>`;

  // Iteramos sobre las categorías provenientes de la configuración
  list.forEach((category) => {
    const slug = readText(category.slug);
    if (!slug || seenSlugs.has(slug)) return; // slug vacío o duplicado
    seenSlugs.add(slug);

    // Todos los enlaces de categoría llevan a la página correspondiente
    // con la clase activa para resaltar la categoría actual.
    // Se usa href como fallback cuando JavaScript está desactivado;
    // la navegación real la maneja onNavigateClick sin recarga (R13).
    const isActive = slug === requested;
    const extraClass = isActive ? ' class="nav-active" aria-current="page"' : '';
    navHtml += `<a href="categoria.html?slug=${slug}"${extraClass}>${escapeHtml(category.name)}</a>`;
  });

  return navHtml;
}

// R13: cuando la persona usuaria elija otra categoría, el contenido se actualiza sin recarga completa.
// R14: el identificador de la categoría seleccionada se refleja en el parámetro `slug` de la URL.
// R15: cuando el cambio provenga de la acción de la persona usuaria, se añade una entrada al historial;
//     cuando la URL llege con un slug inválido, se corrige sin generar entrada de historial.

// Directorio de trabajo actual: la URL se reconstruye siempre relativa a la carpeta desde la que se
// navega, para que la SPA funcione igual en la raíz del sitio que en un subdirectorio.
function currentDirectory() {
  const pathname = window.location.pathname;
  return pathname.slice(0, pathname.lastIndexOf('/') + 1);
}

// URL de destino de una vista, con el parámetro de categoría puesto o retirado y sin ancla.
function buildViewUrl(view, slug) {
  const url = new URL(window.location.href);
  const fileName = view === 'category' ? 'categoria.html' : 'index.html';

  url.pathname = `${currentDirectory()}${fileName}`;
  url.hash = '';

  if (view === 'category') {
    const value = readText(slug);
    if (value) url.searchParams.set('slug', value);
    else url.searchParams.delete('slug');
  } else {
    url.searchParams.delete('slug');
  }

  return url;
}

// Actualiza la URL usando la API de historial.
// `view` es 'home' o 'category'; `slug` solo se tiene en cuenta para la vista de categoría.
// Si `replace` es true, reemplaza la entrada actual; si false, añade una nueva entrada.
// Cuando el slug es desconocido/inválido, se usa la categoría predeterminada y se fuerza el
// reemplazo, para corregir la URL sin añadir entrada al historial (R15). Devuelve el slug
// realmente escrito, de modo que el llamante repinte con la categoría correcta.
function syncUrl(view, slug, { replace } = {}) {
  const target = readText(view) === 'category' ? 'category' : 'home';
  const config = siteState.config;
  let targetSlug = target === 'category' ? readText(slug) : '';
  let mustReplace = replace === true;

  if (target === 'category' && config && config.categoryIndex && !config.categoryIndex.has(targetSlug)) {
    targetSlug = readText(config.defaultSlug);
    mustReplace = true;
  }

  const url = buildViewUrl(target, targetSlug);

  // Nunca se asigna window.location.search: eso recargaría la página entera (R13).
  if (mustReplace) {
    window.history.replaceState({}, '', url);
  } else {
    window.history.pushState({}, '', url);
  }

  return targetSlug;
}

// R15, R19: corrige la URL de carga inicial cuando el identificador no corresponde a la categoría
// que se va a mostrar (por ejemplo ?slug=noexiste, que se resuelve en la predeterminada). Solo se
// toca el parámetro `slug`, nunca el fichero de la dirección: R19 pide corregir el identificador,
// no cambiar de página, y además una corrección que reescribiera la ruta dejaría la misma vista en
// dos direcciones distintas según llegara válida o no. Solo se escribe cuando el identificador de la
// dirección y el resuelto difieren, de modo que un repintado normal no toca el historial; y se
// escribe con replaceState, que no crea una entrada nueva.
function ensureCanonicalSlug(resolvedSlug) {
  const config = siteState.config;
  if (!config) return;

  const slug = readText(resolvedSlug);
  const url = new URL(window.location.href);
  const current = readText(url.searchParams.get('slug'));
  if (current === slug) return;

  if (slug) url.searchParams.set('slug', slug);
  else url.searchParams.delete('slug');

  window.history.replaceState({}, '', url);
}

// Categoría que hace de reserva cuando un enlace de categoría llega sin parámetro.
function fallbackCategorySlug() {
  return siteState.config ? readText(siteState.config.defaultSlug) : '';
}

// R13, R14, R15: único camino de navegación para el clic. El navegador emite también un evento
// `click` al activar un enlace con Enter, así que un manejador de teclado aparte duplicaría la
// entrada de historial del mismo clic: solo se registra este. Cualquier condición que no se
// cumpla devuelve sin tocar el evento y el navegador navega con normalidad (enlaces externos,
// correo, anclas, páginas legales y las aperturas de pestaña con tecla modificadora).
function onNavigateClick(event) {
  if (event.defaultPrevented) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const origin = event.target;
  if (!origin || typeof origin.closest !== 'function') return;

  const link = origin.closest('a');
  if (!link || !link.href) return;
  if (link.dataset.stateAction) return; // acciones de reintento de los estados

  const rawHref = readText(link.getAttribute('href'));
  if (rawHref.startsWith('#')) return; // anclas de la propia página

  let target;
  try {
    target = new URL(link.href, window.location.href);
  } catch {
    return;
  }

  if (target.origin !== window.location.origin) return;

  const fileName = target.pathname.slice(target.pathname.lastIndexOf('/') + 1);
  const isShell = fileName === '' || fileName === 'index.html' || fileName === 'categoria.html';
  if (!isShell) return; // páginas legales, otras rutas y destinos ajenos a la plantilla

  // La viabilidad se decide según la vista de DESTINO y el marcado de este documento, y siempre
  // antes de preventDefault: sin contenedor no se cancela la acción y el navegador navega con
  // recarga normal. La vista de categoría solo exige el listado (#category-products), que existe
  // tanto en index.html (dentro de #category-view) como en categoria.html, así que cambiar de
  // categoría desde la propia página de categoría también es SPA (R13). La vista de portada exige
  // el shell #home-view: sin él (categoria.html y páginas legales) "Inicio" navega con recarga.
  const wantsCategory = fileName === 'categoria.html';
  const canRenderSpa = wantsCategory
    ? Boolean(document.getElementById('category-products'))
    : Boolean(document.getElementById('home-view'));
  if (!canRenderSpa) return;

  event.preventDefault();

  if (fileName === 'categoria.html') {
    const slug = readText(target.searchParams.get('slug')) || fallbackCategorySlug();
    syncUrl('category', slug, { replace: false });
  } else {
    syncUrl('home', null, { replace: false });
  }

  renderCurrentView();
}

// R16: atrás y adelante repintan la vista que corresponda a la URL. La vista activa se deriva de
// la dirección en cada repintado, así que repintar basta: no hay estado mutable que recalcular.
function onPopState() {
  renderCurrentView();
}

// R26: un único aviso por carga con el detalle de todo lo descartado. Solo llega a la consola:
// la interfaz no muestra lo omitido, porque no es contenido del sitio.
function reportDiscarded(list) {
  discardState.entries = discardState.entries.concat(
    (list && Array.isArray(list) ? list.filter((entry) => entry && entry.id) : [])
  );

  if (discardState.entries.length === 0) return;
  if (discardState.reported) return;

  discardState.reported = true;

  const detail = discardState.entries
    .map((entry) => `${entry.id} [faltan: ${entry.missing.join(', ')}] ${entry.reason}`)
    .join(' || ');

  console.warn(
    `Contenido no publicable omitido (${discardState.entries.length}). ` +
      `Solo aviso de consola, no se muestra en la interfaz: ${detail}`
  );
}

// Traza de como se ha validado el catálogo, para que T7 y T8 puedan distinguirla. No se muestra en
// la interfaz: solo la declara el estado de error de carga, que es de T7 y T8, porque en el resto de
// vistas solo explicaría un fallo de datos que ya se comunica con su propio estado.
function describeValidation(config) {
  if (config) {
    return { mode: 'full', categoryChecked: true, note: '' };
  }

  return {
    mode: 'partial',
    categoryChecked: false,
    note: 'Sin configuración no se puede comprobar la existencia de la categoría: se validan el nombre, la declaración de categoría y el enlace de afiliado.'
  };
}

function buildSiteState(flows) {
  siteState.config = flows.config.status === 'ready' ? normalizeConfig(flows.config.data) : null;
  siteState.discarded = siteState.config ? siteState.config.discarded.slice() : [];
  siteState.validation = describeValidation(siteState.config);

  const catalogReady = flows.catalog.status === 'ready' && Array.isArray(flows.catalog.data);
  const rawProducts = catalogReady ? flows.catalog.data : [];
  const categoryIndex = siteState.config ? siteState.config.categoryIndex : null;

  siteState.products = [];

  rawProducts.forEach((raw, position) => {
    const result = normalizeProduct(raw, categoryIndex);

    if (result.ok) {
      siteState.products.push(result.product);
      return;
    }

    const source = raw && typeof raw === 'object' ? raw : {};
    siteState.discarded.push({
      kind: 'product',
      id: readText(source.id) || readText(source.slug) || `producto en la posicion ${position + 1}`,
      slug: readText(source.slug),
      missing: result.missing,
      reason: result.reasons.join('. ')
    });
  });

  return siteState;
}

async function loadSiteData() {
  resetDiscarded();
  resetFeatured();
  await Promise.allSettled([startConfigFlow(), startCatalogFlow()]);
  buildSiteState(dataFlows);
  reportDiscarded(siteState.discarded);

  // Load category text under consent first — best-effort, cannot break catalog/config
  // T6 (R20): en una vista de categoría se pide el texto del slug que se VA A PINTAR, no el crudo
  // de la URL: una URL sin slug o con un identificador desconocido cae en la categoría
  // predeterminada (resolución de spec 001) y su .md tendría que llegar igualmente antes del
  // primer repintado. Así el estado de carga existente de la vista cubre también esta lectura y
  // la página de categoría nunca sale del estado de carga sin su cuerpo resuelto. En portada no
  // se pide nada: allí no se muestra texto de categoría (un prefetch del destino por defecto
  // sería una petición inútil en la home).
  const requestedSlug =
    currentViewName() === 'category'
      ? readText(resolveActiveCategory().slug)
      : readText(new URLSearchParams(window.location.search).get('slug'));
  try {
    // T4: el texto se pide a través de la caché por slug, de modo que el repintado de la vista
    // (que viene después) no repite la petición. Un reintento empieza con la caché vacía: un
    // fallo transitorio del primer intento no deja al texto de la sesión sin volver a leerlo.
    categoryTextCache.clear();
    const categoryText = await resolveCategoryText(requestedSlug);
    siteState.categoryText = categoryText;
  } catch (error) {
    console.error('Category text load failed, continuing without it', error);
    siteState.categoryText = null;
  }

  return dataFlows;
}

function applyTheme(theme) {
  if (!theme) return;

  const root = document.documentElement;
  Object.entries(theme).forEach(([key, value]) => {
    const cssVar = `--color-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
    root.style.setProperty(cssVar, value);
  });
}

// ============================================================================
// Textos de negocio del esqueleto (R10, R32)
// ============================================================================

// Cada vista es un esqueleto: los textos de portada, encabezados, tarjeta lateral, banner de cookies
// y pie no están escritos en el HTML, sino que llegan desde la configuración. Estas tablas declaran
// qué elemento se completa con qué dato, de modo que mover un literal del HTML a config.json es una
// fila más y no una instrucción imperativa nueva. Un dato ausente deja el elemento vacío: no se
// inventa texto ni se conserva el de plantilla.

// Datos de site, que identifican al sitio y no son textos de interfaz.
const SITE_TEXT_TARGETS = [
  ['[data-site-brand]', 'name'],
  ['[data-site-hero-eyebrow]', 'tagline']
];

// Textos de interfaz de globalTexts, por página.
const GLOBAL_TEXT_TARGETS = [
  ['[data-site-hero-title]', 'heroTitle'],
  ['[data-site-hero-text]', 'heroText'],
  ['[data-site-hero-primary-cta]', 'heroPrimaryCta'],
  ['[data-site-hero-secondary-cta]', 'heroSecondaryCta'],
  ['[data-site-hero-card-pill]', 'heroCardPill'],
  ['[data-site-hero-card-title]', 'heroCardTitle'],
  ['[data-site-featured-eyebrow]', 'featuredEyebrow'],
  ['[data-site-featured-title]', 'featuredTitle'],
  ['[data-site-products-eyebrow]', 'productsEyebrow'],
  ['[data-site-products-title]', 'productsTitle'],
  ['[data-site-footer-line]', 'footerLine']
];

const COOKIE_TEXT_TARGETS = [
  ['[data-site-cookie-text]', 'cookieBannerText'],
  ['[data-site-cookie-accept]', 'cookieAccept'],
  ['[data-site-cookie-reject]', 'cookieReject']
];

// El banner de cookies se muestra en cuanto existe el DOM, y puede hacerlo incluso sin configuración,
// porque no depende del catálogo ni de ningún dato de la vista (R24). Sus rótulos tienen reserva en
// código para que los dos botones siempre tengan nombre accesible (R42, R43) igual que el estado de
// cargando, que también se pinta antes de que lleguen los datos. En cuanto la configuración está
// cargada, manda ella: estas cadenas solo cubren esa ventana.
const COOKIE_TEXT_FALLBACKS = {
  cookieBannerText:
    'Utilizamos cookies para medir el tráfico y mejorar la experiencia. Puedes aceptar o rechazar antes de activar la telemetría.',
  cookieAccept: 'Aceptar',
  cookieReject: 'Rechazar'
};

// El texto se escribe con textContent, que no interpreta marcado: por eso aquí no hace falta
// escapeHtml, que queda reservado para las marcas que se construyen con innerHTML (R29).
function fillTextTargets(targets, texts, fallbacks = {}) {
  targets.forEach(([selector, key]) => {
    const node = document.querySelector(selector);
    if (!node) return;
    node.textContent = readText(texts[key]) || readText(fallbacks[key]);
  });
}

// Único texto del esqueleto que llega como colección: la lista de la tarjeta lateral. Cada punto es un
// elemento propio y pasa por escapeHtml, porque la lista se construye con innerHTML (R29). Sin
// colección, sin dato o con puntos vacíos, la lista queda vacía en lugar de mostrar placeholders.
function renderHeroCardPoints(globalTexts) {
  const list = document.querySelector('[data-site-hero-card-points]');
  if (!list) return;

  const declared = globalTexts.heroCardPoints;
  const points = Array.isArray(declared) ? declared.map((point) => readText(point)).filter(Boolean) : [];

  list.innerHTML = points.map((point) => `<li>${escapeHtml(point)}</li>`).join('');
}

// R32: vía de contacto en el pie, tomada de site.contactEmail y mostrada como enlace mailto, sin
// página de contacto nueva. El href se fija con setAttribute, no con innerHTML, de modo que un valor
// hostil no puede inyectar marcado; y el prefijo mailto impide que el valor cambie de esquema. Sin
// correo declarado no hay enlace: un mailto vacío sería un control roto.
function renderFooterContact(config) {
  const link = document.querySelector('[data-site-contact-link]');
  if (!link) return;

  const site = config.site && typeof config.site === 'object' ? config.site : {};
  const email = readText(site.contactEmail);

  if (!email) {
    link.removeAttribute('href');
    link.textContent = '';
    return;
  }

  const label = readText(config.globalTexts && config.globalTexts.contactLabel);
  link.setAttribute('href', `mailto:${email}`);
  link.textContent = label ? `${label}: ${email}` : email;
}

// R35, R42: rótulos del banner disponibles desde el primer momento, con o sin configuración.
function applyCookieTexts() {
  const config = siteState.config;
  const texts = config && config.globalTexts ? config.globalTexts : {};
  fillTextTargets(COOKIE_TEXT_TARGETS, texts, COOKIE_TEXT_FALLBACKS);
}

function applyGlobalTexts(config) {
  const site = config.site && typeof config.site === 'object' ? config.site : {};
  const texts = config.globalTexts && typeof config.globalTexts === 'object' ? config.globalTexts : {};

  fillTextTargets(SITE_TEXT_TARGETS, site);
  fillTextTargets(GLOBAL_TEXT_TARGETS, texts);
  renderHeroCardPoints(texts);
  renderFooterContact(config);
  applyCookieTexts();
}

function applyConfig(config) {
  if (!config) return;

  window.__SITE_CONFIG__ = config;
  applyTheme(config.theme);
  applyGlobalTexts(config);

  // R38: la configuración ya está en el documento. cookies.js escucha este aviso a nivel de
  // módulo para poder cargar la telemetría cuando hay consentimiento guardado: sin él,
  // loadTelemetry() se ejecutaba antes de que existiera el proveedor configurado y no iniciaba
  // nada. Se despacha también en los reintentos; el guard de loadTelemetry evita duplicados.
  document.dispatchEvent(new CustomEvent('siteconfigready'));
}

// Candidatos al bloque de destacados. Se exige lo mismo que en normalizeProduct (nombre, categoría
// y enlace de afiliado) para que la función siga siendo correcta aunque alguien la llame con el
// catálogo sin normalizar; en la página de inicio recibe siteState.products, que ya son solo
// publicables (R2, R4).
function isFeaturedCandidate(product) {
  const source = product && typeof product === 'object' ? product : {};

  return (
    readText(source.category) === FEATURED_CATEGORY &&
    readText(source.name) !== '' &&
    readText(source.affiliateUrl) !== ''
  );
}

// R2, R4: barajado parcial de Fisher-Yates. Solo recorre los índices que necesita, de modo que cada
// índice visitado puede caer una sola vez en el tramo elegido y nunca se repite un producto. No toca
// el array recibido, porque filter devuelve una copia y los listados de categoría deben conservar
// el orden declarado en el catálogo (R7).
function pickFeaturedProducts(products, max = FEATURED_LIMIT) {
  const source = Array.isArray(products) ? products : [];
  const requested = readOptionalNumber(max);
  const limit = requested === null ? 0 : Math.max(0, Math.floor(requested));
  const candidates = source.filter(isFeaturedCandidate);

  for (let index = 0; index < limit && index < candidates.length; index += 1) {
    const random = index + Math.floor(Math.random() * (candidates.length - index));
    const held = candidates[index];
    candidates[index] = candidates[random];
    candidates[random] = held;
  }

  return candidates.slice(0, limit);
}

// R3: la elección se resuelve una sola vez por carga y se reutiliza después. Si no hay candidatos
// la cachea igual, como lista vacía, para que un repintado posterior no vuelva a sortear.
function selectFeaturedProducts(products, max = FEATURED_LIMIT) {
  if (featuredState.selection === null) {
    featuredState.selection = pickFeaturedProducts(products, max);
  }
  return featuredState.selection;
}

// R5,R7,R8,R25,R29,R43,R44,R46: ficha de producto compartida. Omite elementos sin dato (sin
// literales vacíos ni espacios reservados; sin imagen no se emite el <img>), formatea precio con
// moneda del producto, usa escapeHtml en todos los campos del catálogo, añade ancho/alto solo si
// válidos y solo cuando hay imagen para evitar salto de contenido, enlace con
// target="_blank", rel="sponsored nofollow" y aviso perceptible en aria-label.
function buildProductCard(product) {
  const p = product && typeof product === 'object' ? product : {};
  const name = escapeHtml(p.name);
  const badge = readText(p.badge);
  const price = formatPrice(p.price, p.currency);
  const desc = readText(p.shortDescription);
  const img = readText(p.image);
  const url = readText(p.affiliateUrl);

  // R25: sin imagen declarada no se emite ningún <img> ni caja reservada: la ficha se muestra sin
  // ese elemento, sin literales vacíos y sin un hueco que quede sin llenar. Los atributos de reserva
  // (src, alt, loading y width/height con 200x220 por defecto) solo se escriben cuando sí hay imagen,
  // porque su propósito es reservar el espacio de la imagen que existe (R43, R46).
  let imgHtml = '';
  if (img) {
    const width = readOptionalNumber(p.imageWidth) || 200;
    const height = readOptionalNumber(p.imageHeight) || 220;
    imgHtml = `<img src="${escapeHtml(img)}" alt="${name}" loading="lazy" width="${width}" height="${height}" />`;
  }

  const badgeHtml = badge ? `<span class="badge">${escapeHtml(badge)}</span>` : '';
  const priceHtml = price ? `<span class="price">${escapeHtml(price)}</span>` : '';
  const descHtml = desc ? `<p>${escapeHtml(desc)}</p>` : '';
  const href = url ? escapeHtml(url) : '';

  const notice = siteState?.config?.globalTexts?.externalLinkNotice
    ? siteState.config.globalTexts.externalLinkNotice
    : 'abre en una pestaña nueva';

  const noticeHtml = notice
    ? `<span class="external-link-notice">${escapeHtml(notice)}</span>`
    : '';

  const linkHtml = notice
    ? `<a href="${href}" rel="sponsored nofollow" target="_blank" aria-label="Ver oferta de ${name} (se abre en una nueva pestaña)">Ver oferta ${noticeHtml}</a>`
    : `<a href="${href}" rel="sponsored nofollow" target="_blank" aria-label="Ver oferta de ${name} (se abre en una nueva pestaña)">Ver oferta</a>`;

  return `
    <article class="product-card">
      ${imgHtml}
      <div class="product-body">
        <div class="product-topline">
          ${badgeHtml}
          ${priceHtml}
        </div>
        <h3>${name}</h3>
        ${descHtml}
        ${linkHtml}
      </div>
    </article>
  `;
}

// R30, R31: marcado estructurado Schema.org regenerado en cada renderizado.
// Una entidad Product por cada producto visible; sin productos, entidad de página y categoría sin ofertas.
function buildStructuredData({ category, products }) {
  const result = {
    '@context': 'https://schema.org',
    '@graph': []
  };

  if (products && products.length > 0) {
    // R30: una entidad Product por cada producto visible
    products.forEach((product) => {
      const p = product && typeof product === 'object' ? product : {};
      result['@graph'].push({
        '@type': 'Product',
        'name': p.name || '',
        'image': p.image || '',
        'description': p.shortDescription || '',
        'offers': {
          '@type': 'Offer',
          'price': p.price,
          'priceCurrency': p.currency,
          'url': p.affiliateUrl
        }
      });
    });
  } else {
    // R31: sin productos, entidad de página y categoría sin ofertas. El nombre y la descripción de
    // la página salen de la configuración (R10): no hay textos de negocio escritos en el código, y
    // sin configuración ambos quedan vacíos en lugar de anunciar una plantilla que ya no se ve.
    //
    // La URL de ambas entidades se construye con el helper de navegación (buildViewUrl, T1) en vez
    // de concatenar sobre window.location.href: la dirección cruda puede traer un `slug` vacío
    // (index.html?slug=), una ancla (#featured) o, en el caso de la categoría, un parámetro repetido
    // (…?slug=saas?slug=saas). La vista activa se deriva de la URL, igual que en cada repintado.
    const view = currentViewName();
    const pageSlug = readText(new URLSearchParams(window.location.search).get('slug'))
      || (category ? readText(category.slug) : '');
    const pageUrl = view === 'category'
      ? buildViewUrl('category', pageSlug).href
      : buildViewUrl('home').href;

    const pageEntity = {
      '@type': 'WebPage',
      'name': readText(siteState.config?.site?.name),
      'description': readText(siteState.config?.site?.tagline),
      'url': pageUrl
    };
    result['@graph'].push(pageEntity);

    if (category) {
      result['@graph'].push({
        '@type': 'CollectionPage',
        'name': category.name,
        'description': category.description,
        'url': buildViewUrl('category', category.slug).href
      });
    }
  }

  return result;
}

// R30, R31: actualiza el nodo de marcado estructurado en el DOM.
// Acepta los productos filtrados para la categoría actual opcionalmente.
function updateStructuredData(products, category) {
  const config = siteState.config;
  const cats = config && config.categories ? config.categories : [];
  // Si no se pasa categoría, intentar resolverla de la URL
  let cat = category;
  if (!cat) {
    const currentSlug = readText(new URLSearchParams(window.location.search).get('slug'));
    if (currentSlug) {
      cat = cats.find((c) => readText(c.slug) === currentSlug);
    }
  }
  if (!cat && cats.length > 0) {
    cat = cats[0];
  }

  // Usa los productos pasados (ya filtrados por la vista actual) o cae back a siteState.products
  const productsToUse = products || siteState.products;

  const structuredData = buildStructuredData({ category: cat, products: productsToUse });

  // Actualizar el nodo script en el DOM
  const node = document.getElementById('structured-data');
  if (!node) return;

  // Serializar a JSON-LD string
  node.textContent = JSON.stringify(structuredData);
}

// R33, R34, R15: único punto por el que se escribe la descripción en los tres metadatos que la
// comparten (description, og:description y twitter:description). updateMeta la usa al componer
// los metadatos de cada repintado y T5 la reutiliza cuando el texto de la categoría resuelve
// fuera de ese repintado (navegación sin recarga), de modo que las tres réplicas no puedan
// quedar desincronizadas. setAttribute fija texto, nunca marcado: no hay interpretación HTML.
function writeMetaDescription(description) {
  const value = description || '';

  const metaDescription = document.querySelector('meta[name="description"]');
  if (metaDescription) metaDescription.setAttribute('content', value);

  const ogDescription = document.querySelector('meta[property="og:description"]');
  if (ogDescription) ogDescription.setAttribute('content', value);

  const twitterDescription = document.querySelector('meta[name="twitter:description"]');
  if (twitterDescription) twitterDescription.setAttribute('content', value);
}

// R33, R34: actualiza los metadatos del documento (title, descripción canonical y sociales)
// según la categoría mostrada. Se llama en todos los estados de la vista de categoría y en la
// portada. `fullTitle` permite escribir un título ya compuesto (la portada no tiene categoría);
// `og:title` y `twitter:title` reciben el mismo título que verá quien comparta la página.
function updateMeta({ title, description, image, url: canonicalUrl, fullTitle }) {
  const siteName = readText(siteState.config?.site?.name);

  // 1. Actualizar título del documento
  const composedTitle = title ? `${title} | ${siteName}` : siteName;
  const shareTitle = fullTitle || composedTitle || 'Plantilla de afiliados';
  document.title = shareTitle;

  // 2. Actualizar meta description (description, og:description y twitter:description juntos)
  writeMetaDescription(description);

  // 3. Actualizar canonical URL
  const resolvedUrl = canonicalUrl || window.location.href;
  const canonicalLink = document.querySelector('link[rel="canonical"]');
  if (canonicalLink) {
    canonicalLink.setAttribute('href', resolvedUrl);
  }

  // 4. Actualizar meta tags Open Graph
  const ogType = document.querySelector('meta[property="og:type"]');
  if (ogType) ogType.setAttribute('content', 'website');

  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) ogTitle.setAttribute('content', shareTitle);

  const ogImage = document.querySelector('meta[property="og:image"]');
  if (ogImage) ogImage.setAttribute('content', image || '');

  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) ogUrl.setAttribute('content', resolvedUrl);

  // 5. Actualizar meta tags Twitter
  const twitterCard = document.querySelector('meta[name="twitter:card"]');
  if (twitterCard) twitterCard.setAttribute('content', image ? 'summary_large_image' : 'summary');

  const twitterTitle = document.querySelector('meta[name="twitter:title"]');
  if (twitterTitle) twitterTitle.setAttribute('content', shareTitle);

  const twitterImage = document.querySelector('meta[name="twitter:image"]');
  if (twitterImage) twitterImage.setAttribute('content', image || '');
}

// Función auxiliar para obtener la categoría activa desde siteState
function getCurrentCategory() {
  const config = siteState.config;
  if (!config) return null;
  const categories = config.categories;
  if (!categories || categories.length === 0) return null;
  const currentSlug = readText(new URLSearchParams(window.location.search).get('slug'));
  if (currentSlug) {
    return categories.find((cat) => readText(cat.slug) === currentSlug) || categories[0];
  }
  return categories[0] || null;
}

// Los cuatro estados son excluyentes entre sí (S7, R21, R23): en cada momento la vista muestra el
// listado o un único estado, nunca el listado y un estado a la vez, ni dos estados.
const STATE_KINDS = ['loading', 'empty', 'error', 'unavailable'];

// Claves de configuración de cada estado (R10). Solo el estado de cargando y el de error tienen un
// rótulo propio de estado; el vacío ofrece además su acción de salida hacia las demás categorías
// (R21) y el de error la de reinicio (R23).
const STATE_TEXT_KEYS = {
  loading: { title: 'loadingTitle', text: 'loadingText' },
  empty: { title: 'emptyTitle', text: 'emptyText', action: 'emptyAction' },
  error: { title: 'errorTitle', text: 'errorText', action: 'errorAction' },
  unavailable: { title: 'unavailableTitle', text: 'unavailableText' }
};

// Rótulos de reserva para el caso en que todavía no hay configuración cargada: el estado de cargando
// se pinta antes de que llegue el primer JSON y el de error puede pintarse con la configuración
// caída, de modo que ningún estado puede aparecer sin rótulo. Siempre que la configuración declare
// el texto, manda la configuración; estas cadenas solo cubren la ventana previa a los datos.
const STATE_FALLBACK_TEXTS = {
  loading: {
    title: 'Cargando contenido',
    text: 'Estamos obteniendo los datos del sitio. Esto suele tardar solo un momento.'
  },
  empty: {
    title: 'Todavía no hay productos aquí',
    text: 'Esta categoría aún no tiene recomendaciones. Prueba con otra de las disponibles.',
    action: 'Ver todas las categorías'
  },
  error: {
    title: 'No hemos podido cargar el contenido',
    text: 'Ha ocurrido un problema al obtener los datos del sitio. Puedes volver a intentarlo.',
    action: 'Reintentar'
  },
  unavailable: {
    title: 'Contenido no disponible',
    text: 'No hay categorías configuradas en este momento.'
  }
};

// Contenedores de estado de cada página, por orden de preferencia cuando el llamante no indica
// destino. Cada contenedor declara en `data-state-for` el listado que sustituye.
const STATE_TARGET_IDS = ['category-state', 'featured-state'];

function resolveStateTarget(target) {
  if (target && typeof target === 'object' && typeof target.nodeType === 'number') return target;

  const id = readText(target);
  if (id) return document.getElementById(id);

  for (let index = 0; index < STATE_TARGET_IDS.length; index += 1) {
    const candidate = document.getElementById(STATE_TARGET_IDS[index]);
    if (candidate) return candidate;
  }

  return null;
}

function readGlobalText(key, fallback) {
  const globalTexts = siteState.config && siteState.config.globalTexts ? siteState.config.globalTexts : {};
  return readText(globalTexts[key]) || readText(fallback);
}

// R21, R23: pinta uno de los cuatro estados en su contenedor y oculta el listado que sustituye.
// Cualquier otro valor de `kind` (o ninguno) limpia el contenedor y devuelve la visibilidad al
// listado, de modo que estado y productos nunca coexisten. Devuelve el estado pintado, o null si la
// vista queda mostrando contenido. Todos los textos pasan por escapeHtml, porque el marcado se
// construye con innerHTML (R29).
function renderState(kind, payload = {}) {
  const container = resolveStateTarget(payload.target);
  if (!container) return null;

  const state = readText(kind);
  const linkedId = container.dataset ? readText(container.dataset.stateFor) : '';
  const linked = linkedId ? document.getElementById(linkedId) : null;

  STATE_KINDS.forEach((name) => container.classList.remove(`state-${name}`));

  if (STATE_KINDS.indexOf(state) === -1) {
    container.innerHTML = '';
    container.classList.remove('state');
    container.hidden = true;
    container.removeAttribute('role');
    container.removeAttribute('aria-busy');
    if (linked) linked.hidden = false;
    return null;
  }

  const keys = STATE_TEXT_KEYS[state];
  const fallback = STATE_FALLBACK_TEXTS[state];
  const title = readText(payload.title) || readGlobalText(keys.title, fallback.title);
  const text = readText(payload.text) || readGlobalText(keys.text, fallback.text);
  const actionLabel =
    readText(payload.actionLabel) ||
    (keys.action ? readGlobalText(keys.action, fallback.action) : '');

  let actionHtml = '';

  if (actionLabel && state === 'error') {
    // R23: acción de reinicio. El atributo `data-state-action` es el enganche, y lo atiende el
    // manejador delegado del documento, porque este botón se crea y se borra en cada pintado.
    actionHtml =
      `<button type="button" class="button button-primary" data-state-action="retry">` +
      `${escapeHtml(actionLabel)}</button>`;
  } else if (actionLabel && state === 'empty') {
    // R21: salida hacia las demás categorías, que la navegación de la página ofrece.
    const href = readText(payload.actionHref) || 'index.html';
    actionHtml =
      `<a class="button button-secondary" href="${escapeHtml(href)}">${escapeHtml(actionLabel)}</a>`;
  }

  container.classList.add('state', `state-${state}`);
  container.hidden = false;
  container.setAttribute('role', state === 'error' ? 'alert' : 'status');
  if (state === 'loading') container.setAttribute('aria-busy', 'true');
  else container.removeAttribute('aria-busy');
  if (linked) linked.hidden = true;

  container.innerHTML = `
    <span class="state-marker" aria-hidden="true"></span>
    <p class="state-title">${escapeHtml(title)}</p>
    ${text ? `<p class="state-text">${escapeHtml(text)}</p>` : ''}
    ${actionHtml ? `<div class="state-actions">${actionHtml}</div>` : ''}
  `;

  return state;
}

// R7, R11: productos publicables de una categoría, en el orden declarado en el catálogo.
// siteState.products ya contiene solo productos publicables, así que aquí no hay nada que descartar;
// filter conserva el orden de la entrada y esta versión no ofrece ordenación, filtro ni búsqueda
// (R11).
function productsInCategory(slug) {
  const key = readText(slug);
  return siteState.products.filter((product) => product && readText(product.category) === key);
}

// R5, R7, R11: listado de la categoría indicada, pintado con la misma ficha que los destacados. Por
// eso un producto de la categoría de destacados aparece también en su propio listado y lleva
// directo al enlace de afiliado, sin página individual (R5).
function renderCategoryGrid(slug) {
  const container = document.getElementById('category-products');
  const products = productsInCategory(slug);

  if (container) {
    container.innerHTML = products.map((product) => buildProductCard(product)).join('');
  }

  return products;
}

// R20, R21, R23, R24: decide el estado exclusivo de la vista de categoría y, si procede, pinta el
// listado. El catálogo es el dato que sostiene el listado: si su flujo falló, no hay productos que
// mostrar y toca el estado de error con acción de reinicio (R23). Sin categorías configuradas no hay
// vista que mostrar (R20). Con productos, listado; si no, estado vacío (R21), que nunca se confunde
// con el de error. Y si la configuración ha caído pero el catálogo está cargado, los productos se
// siguen mostrando: el fallo de uno no oculta el contenido del otro (R24). Devuelve 'list',
// 'empty', 'unavailable' o 'error'. R30, R31: marcado estructurado.
function renderCategoryView(slug) {
  const products = productsInCategory(slug);
  const categories = siteState.config ? siteState.config.categories : [];
  // R33, R34: la categoría que se MUESTRA, resuelta por el slug de la URL. Nunca la primera de la
  // lista, que sería otro contenido distinto del que está en pantalla.
  const shownCategory = categories.find((cat) => readText(cat.slug) === slug) || null;

  if (dataFlows.catalog.status === 'error') {
    renderState('error', { target: 'category-state' });
    updateStructuredData([], null);
    // R33, R34: el estado de error también lleva metadatos propios, para no dejar el título
    // estático del HTML. Con categoría: sus datos; sin ella: valores neutrales (solo el nombre
    // del sitio y la descripción de reserva). T5 (R13, R14): la descripción sale de
    // generateMetaDescription, que con texto válido usa su primer párrafo y sin él la de config.
    updateMeta({
      title: shownCategory ? shownCategory.title : '',
      description: generateMetaDescription(
        slug,
        shownCategory
          ? shownCategory.description
          : readText(siteState.config?.site?.tagline) || ''
      ),
      image: shownCategory ? shownCategory.featuredImage : '',
      url: window.location.href
    });
    return 'error';
  }

  if (products.length > 0) {
    renderState(null, { target: 'category-state' });
    renderCategoryGrid(slug);
    updateStructuredData(products);
    // R33, R34: actualizar metadatos para la categoría con productos
    const categoryForMeta = shownCategory || categories[0] || null;
    updateMeta({
      title: categoryForMeta ? categoryForMeta.title : '',
      // T5 (R13, R14): primer párrafo del texto si la categoría tiene texto válido; si no,
      // la descripción de configuración de esa misma categoría.
      description: generateMetaDescription(
        slug,
        categoryForMeta ? categoryForMeta.description : ''
      ),
      image: categoryForMeta ? categoryForMeta.featuredImage : '',
      url: window.location.href
    });
    return 'list';
  }

  // R24: con la configuración caída y el catálogo cargado no se pinta el estado de
  // "disponibilidad" (habría categorías si la configuración estuviera bien) ni se oculta el
  // listado: se pinta la rejilla con lo que haya y el fallo global se comunica en #site-state,
  // que no oculta ningún contenedor porque no declara data-state-for.
  if (dataFlows.config.status === 'error') {
    renderState(null, { target: 'category-state' });
    renderCategoryGrid(slug);
    updateStructuredData(products);
    // R33, R34: sin configuración no hay categoría que describir: metadatos neutrales para no
    // dejar el título del HTML. T5: sin categoría resuelta generateMetaDescription no deriva
    // nada del texto (un texto huérfano no describe a ninguna categoría, R22) y devuelve el
    // mismo fallback neutro que hasta ahora.
    updateMeta({
      title: '',
      description: generateMetaDescription(slug, readText(siteState.config?.site?.tagline) || ''),
      image: '',
      url: window.location.href
    });
    return 'list';
  }

  if (categories.length === 0) {
    renderState('unavailable', { target: 'category-state' });
    updateStructuredData([], null);
    // R33, R34: sin categorías configuradas no hay contenido propio que mostrar: neutrales.
    // T5: el índice está vacío, así que generateMetaDescription devuelve el fallback tal cual.
    updateMeta({
      title: '',
      description: generateMetaDescription(slug, readText(siteState.config?.site?.tagline) || ''),
      image: '',
      url: window.location.href
    });
    return 'unavailable';
  }

  renderState('empty', { target: 'category-state' });
  updateStructuredData([], null);
  // R33, R34: la categoría vacía es la que se está mostrando, no la primera de la lista.
  updateMeta({
    title: shownCategory ? shownCategory.title : '',
    // T5 (R13, R14): el estado vacío también lleva la meta descripción del texto si lo hay.
    description: generateMetaDescription(
      slug,
      shownCategory
        ? shownCategory.description
        : readText(siteState.config?.site?.tagline) || ''
    ),
    image: shownCategory ? shownCategory.featuredImage : '',
    url: window.location.href
  });
  return 'empty';
}

// El botón de la portada que apunta al bloque de destacados dejaría el ancla #featured sin destino si
// el bloque se oculta, así que se oculta con él (ancla anotada en T6). Solo existe en la portada.
function setFeaturedCtaVisible(visible) {
  const cta = document.querySelector('[data-site-hero-featured-cta]');
  if (cta) cta.hidden = !visible;
}

// Bloque de destacados de la página de inicio. Muestra exactamente los productos ya elegidos y, si
// no hay candidatos, vacía el contenedor y oculta la sección completa con su cabecera, sin estado de
// error ni hueco visible (R1, R4).
function renderFeaturedBlock(products) {
  const container = document.getElementById('featured-products');
  if (!container) return;

  const block = document.getElementById('featured') || container.closest('section');
  const selection = selectFeaturedProducts(products);

  if (selection.length === 0) {
    container.innerHTML = '';
    if (block) block.classList.add('hidden');
    setFeaturedCtaVisible(false);
    return;
  }

  if (block) block.classList.remove('hidden');

  setFeaturedCtaVisible(true);
  container.innerHTML = selection.map((product) => buildProductCard(product)).join('');
}

// ============================================================================
// T4 · h1 de la vista de categoría (R18, §6.4b)
// ============================================================================

// Textos ya resueltos en la sesión, por slug: el valor es el crudo del .md o null (sin fichero,
// vacío o fallo de red). Sin esta caché, cada vuelta a una categoría volvería a pedir el fichero
// y el h1 tardaría en distinguir entre «con texto» y «sin texto».
const categoryTextCache = new Map();

// Slugs cuyo texto inválido ya se anunció en consola: R2 admite como mucho un aviso y el mismo
// fichero se vuelve a parsear en cada repintado (clic, atrás/adelante, ?slug= directo).
const warnedCategoryTexts = new Set();

// Identificador del último pedido de h1 en curso. Cada repintado lo incrementa, de modo que la
// respuesta de un pedido anterior se descarta y nunca pinta el h1 de una categoría que ya no está
// en pantalla (navegación rápida sin recarga).
let categoryHeadingRequest = 0;

// R18: pedido del texto de una categoría con la caché por delante. loadCategoryText es el único
// que toca la red; el resultado (incluido el null) queda guardado bajo su slug.
async function resolveCategoryText(slug) {
  const key = readText(slug);
  if (!key) return null;
  if (categoryTextCache.has(key)) return categoryTextCache.get(key);

  const text = await loadCategoryText(key);
  categoryTextCache.set(key, text);
  return text;
}

// R18, §6.4b: qué encabezado lleva la página. `isValid` refleja la estructura mínima de R2+R4
// (si falla, el texto se ignora y el h1 vuelve al título de configuración) y `heading` es el
// interior del primer <h1> del texto, ya escapado por parseCategoryText: con innerHTML se
// conserva su formato inline (negrita, cursiva, enlaces, código) y con la lectura estricta del
// trim se descarta un `#` sin texto, para no dejar un h1 vacío en la cabecera.
function readCategoryHeading(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    return { isValid: false, heading: null };
  }

  const parsed = parseCategoryText(rawText);
  if (!parsed.isValid) return { isValid: false, heading: null };

  const match = /<h1>([\s\S]*?)<\/h1>/.exec(parsed.html);
  return { isValid: true, heading: match && match[1].trim() !== '' ? match[1] : null };
}

// R18, §6.4b: único h1 de la vista de categoría. Se reutiliza el nodo <h1 id="category-title">
// del esqueleto y solo cambia su CONTENIDO: con texto válido aloja el # del markdown y el título
// de configuración deja de renderizarse como encabezado (se sustituye, no se apila); sin texto o
// con texto inválido vuelve al título de configuración. Cambiar el contenido del único nodo en
// lugar de ocultar uno y crear otro garantiza por construcción que no haya dos h1 ni saltos de
// nivel en ningún repintado, y que solo se pinte cuando el dato ya está resuelto. La cabecera
// solo pinta su descripción corta (§6.3b), nunca el título de config cuando hay texto.
// Sin categoría resuelta (config caída) el nodo queda vacío y su cabecera oculta: no se conserva
// un título que ya no tiene respaldo.
function renderCategoryHeading(category) {
  const title = document.getElementById('category-title');
  if (!title) return;

  const request = ++categoryHeadingRequest;
  const key = category ? readText(category.slug) : '';
  const fallback = category ? readText(category.title) : '';

  const apply = (raw) => {
    if (request !== categoryHeadingRequest) return; // repintado posterior: este texto ya no manda

    let heading = null;
    if (category && typeof raw === 'string' && raw.trim() !== '') {
      const result = readCategoryHeading(raw);
      heading = result.heading;
      if (!result.isValid && !warnedCategoryTexts.has(key)) {
        warnedCategoryTexts.add(key);
        console.warn(
          `Category text for "${key}" does not have the minimum structure (# title, ## subtitle and body): it is treated as missing.`
        );
      }
    }

    // Estado del texto de la categoría en pantalla: lo necesita T6 para renderizar el cuerpo y
    // evita que un valor antiguo (de la categoría anterior) se confunda con el actual.
    siteState.categoryText = typeof raw === 'string' ? raw : null;

    if (heading !== null) title.innerHTML = heading;
    else title.textContent = fallback;

    // T6 (R1, R2, R9): el cuerpo del texto se pinta con el MISMO crudo, en el MISMO pintado y
    // bajo el MISMO guardia de respuestas tardías que el h1, de modo que cabecera, h1, meta
    // descripción y cuerpo no pueden quedarse mezclados entre dos categorías (R19).
    renderCategoryText(category, raw);

    // T5 (R13, R15): si este texto acaba de resolver fuera del repintado (navegación sin recarga
    // a una categoría cuyo .md no estaba en caché, o respuesta que tarda), la meta descripción se
    // recompone ahora: el repintado la había escrito con la reserva de configuración porque el
    // texto aún no estaba disponible. El guardia de petición de arriba descarta las respuestas
    // tardías de categorías que ya no están en pantalla.
    refreshCategoryMetaDescription(key);
  };

  // El texto de este slug ya se conoce: se aplica dentro del mismo repintado, sin parpadeo.
  if (!key || categoryTextCache.has(key)) {
    apply(key ? categoryTextCache.get(key) : null);
    return;
  }

  // Mientras llega el fichero, el h1 es ya la reserva correcta si el texto no existe; si existe,
  // se sustituye por el # en cuanto resuelve (sin recarga y sin pisar una navegación posterior).
  title.textContent = fallback;
  // T6: mientras no resuelva el texto de ESTA categoría no se conserva en pantalla el cuerpo de la
  // anterior (una navegación sin recarga no puede mostrar el texto de A bajo el h1 de B): el
  // contenedor queda oculto y vacío —sin hueco ni bloque con margen— hasta que `apply` pinte el
  // texto nuevo o confirme que no hay (R2, R3). No se crea ningún estado de carga nuevo: mientras
  // la vista esperó sus datos ya mandaba el existente (R20) y aquí el contenido disponible
  // (cabecera y listado) sigue en pantalla.
  renderCategoryText(category, null);
  resolveCategoryText(key).then(apply);
}

// ============================================================================
// T5 · meta descripción de la vista de categoría (R13, R14, R15)
// ============================================================================

// Límite de R13. El corte es literal por POSICIÓN sobre la cadena que va a vivir en el atributo
// `content` (la ya escapada): 160 caracteres como máximo, sin elipsis y sin corte por palabra;
// si el párrafo llega más largo, quedan exactamente los 160 primeros caracteres.
const META_DESCRIPTION_LIMIT = 160;

// R13, R16, R17: primer párrafo de CUERPO del html que devuelve parseCategoryText. Los bloques
// salen separados por saltos de línea y un párrafo de nivel superior es exactamente `<p>…</p>`
// en su propia línea; los <p> de una cita viajan dentro de `<blockquote>…</blockquote>` y por eso
// se descartan (una cita no es párrafo de cuerpo). El interior ya viene escapado de
// parseCategoryText: aquí solo se retiran las etiquetas inline (strong/em/code/a) y el texto que
// queda es texto seguro — nunca llega marcado al atributo content. El `#` inicial no puede
// aparecer: se parseó como <h1> y este lector solo mira líneas de párrafo. Devuelve '' si no hay
// párrafo utilizable (caso imposible con isValid, pero degradado igualmente).
function readFirstBodyParagraph(html) {
  const source = typeof html === 'string' ? html : '';
  const lines = source.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^<p>([\s\S]*)<\/p>$/.exec(lines[index].trim());
    if (!match) continue;

    const text = match[1].replace(/<[^>]*>/g, '').trim();
    if (text === '') continue;

    return text.length > META_DESCRIPTION_LIMIT ? text.slice(0, META_DESCRIPTION_LIMIT) : text;
  }

  return '';
}

// R13, R14: meta descripción de la categoría indicada. Si la categoría tiene texto válido con
// párrafo de cuerpo, el valor es su primer párrafo truncado a META_DESCRIPTION_LIMIT; sin texto,
// con texto inválido (R2/R4, tratado como inexistente) o sin párrafo, manda la descripción corta
// de config.json.categories[slug]. `fallback` es el valor que el repintado habría usado sin
// texto y solo se consulta cuando el slug no resuelve en la configuración (config caída, slug
// sin categoría): en ese caso no se deriva nada del texto, porque R22 ignora el texto de un
// identificador que ya no resuelve y R33/R34 piden metadatos neutros. La descripción VISIBLE de
// la cabecera no pasa por aquí: sigue siendo la de configuración (§6.3b). No toca el DOM.
function generateMetaDescription(categorySlug, fallback) {
  const key = readText(categorySlug);
  const config = siteState.config;
  const category = config && config.categoryIndex && key ? config.categoryIndex.get(key) : null;

  if (!category) return readText(fallback);

  // La caché por slug es la fuente (no siteState.categoryText, que puede ser aún el texto de la
  // categoría anterior mientras resuelve la nueva).
  const raw = categoryTextCache.has(key) ? categoryTextCache.get(key) : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = parseCategoryText(raw);
    if (parsed.isValid) {
      const paragraph = readFirstBodyParagraph(parsed.html);
      if (paragraph !== '') return paragraph;
    }
  }

  return readText(category.description) || readText(fallback);
}

// R13, R15: recompone la meta descripción cuando el texto de la categoría resuelve fuera del
// repintado (ver renderCategoryHeading). Solo escribe si el texto aporta párrafo propio: si no,
// deja intacta la descripción de configuración que ya escribió el repintado (R14) y los estados
// sin categoría. Los dos guardias impiden que una respuesta tardía pise metadatos ajenos: la
// vista debe seguir siendo la de categoría y la URL debe seguir apuntando a este slug (navegación
// a la portada o a otra categoría en vuelo). La canonical no se toca: la compone updateMeta.
function refreshCategoryMetaDescription(slug) {
  const key = readText(slug);
  if (!key || viewState.page !== 'category') return;

  const urlSlug = readText(new URLSearchParams(window.location.search).get('slug'));
  if (urlSlug !== key) return;

  const description = generateMetaDescription(key);
  if (description !== '') writeMetaDescription(description);
}

// Cabecera de la vista de categoría: nombre, título, descripción e imagen propios de la categoría
// (R33). Arranca oculta en el HTML y sin texto, y solo se muestra cuando hay categoría resuelta:
// mientras cargan los datos no se conoce ninguna, y sin configuración tampoco, así que en ambos
// casos no queda ni una plantilla a la vista (R10). El listado o el estado de la sección de productos
// se pintan igualmente, porque el catálogo carga de forma independiente (R24).
function renderCategoryPage(category) {
  const header = document.getElementById('category-header');
  const categoryName = document.getElementById('category-name');
  const categoryTitle = document.getElementById('category-title');
  const categoryDescription = document.getElementById('category-description');
  const categoryImage = document.getElementById('category-image');

  if (!category) {
    // T4: sin categoría resuelta no hay título que pintar. Además se cancela cualquier h1 en
    // curso, para que la respuesta tardía de un texto no rellene el nodo de una cabecera oculta.
    renderCategoryHeading(null);
    if (header) header.hidden = true;
    return;
  }

  if (header) header.hidden = false;
  if (categoryName) categoryName.textContent = category.name;
  if (categoryTitle) categoryTitle.textContent = category.title;
  if (categoryDescription) categoryDescription.textContent = category.description;
  // T4 (R18, §6.4b): el título de configuración es la reserva. Si la categoría tiene texto
  // válido, renderCategoryHeading sustituye este contenido por el # del markdown; si no, este
  // es ya el valor definitivo y la llamada no cambia nada.
  renderCategoryHeading(category);

  if (categoryImage) {
    // La imagen de categoría no aporta información que el nombre no dé, así que su texto alternativo
    // es el nombre de la categoría (R44). Sin imagen declarada no se deja un elemento sin origen.
    const image = readText(category.featuredImage);
    const frame = categoryImage.closest('.category-feature');

    categoryImage.alt = category.name;
    categoryImage.hidden = image === '';
    if (image) categoryImage.src = image;
    else categoryImage.removeAttribute('src');

    if (frame) frame.hidden = image === '';
  }
}

// ============================================================================
// T6 · cuerpo del texto en la vista de categoría (R1, R2, R3, R9, R19, R20)
// ============================================================================

// R18 (nota que dejó T4): el <h1> del markdown lo aloja la cabecera (#category-title), así que el
// cuerpo no lo debe repetir. El PRIMER <h1> se descarta por completo —es el que ya está en la
// cabecera— y cualquier otro # posterior se degrada a <h2>: la página conserva un único h1 sin
// perder ese contenido y sin saltos de nivel. Solo se quita esa línea: el resto (incluidos los
// saltos de línea DENTRO de un bloque de código, que es lo único multi-línea que emite
// parseCategoryText) se copia tal cual.
function stripCategoryHeadingLines(html) {
  const lines = (typeof html === 'string' ? html : '').split('\n');
  const output = [];
  let headingTaken = false;

  lines.forEach((line) => {
    if (!/^<h1>.*<\/h1>$/.test(line)) {
      output.push(line);
      return;
    }

    if (!headingTaken) {
      headingTaken = true;
      return;
    }

    output.push(line.replace(/^<h1>/, '<h2>').replace(/<\/h1>$/, '</h2>'));
  });

  return output.join('\n');
}

// R1, R2, R3, R9: cuerpo del texto de la categoría. Va SIEMPRE por debajo de la cabecera, que
// conserva su descripción corta de configuración (§6.3b), y por encima del listado completo de la
// sección siguiente (§6.1a): la repetición marcador + listado es intencionada. `rawText` es el
// mismo crudo que acaba de resolver renderCategoryHeading (misma caché por slug, mismo guardia de
// respuestas tardías y mismo pintado), de modo que h1, meta descripción y cuerpo nunca apuntan a
// categorías distintas (R19).
// Sin texto, con texto vacío o con texto inválido (R2 + R4) el contenedor queda OCULTO y vacío:
// ni hueco, ni bloque con margen residual, ni ningún aviso en pantalla (R3; el aviso de consola lo
// emite T4 al resolver el encabezado). El html ya viene escapado de parseCategoryText (R16) y las
// fichas salen tal cual de buildProductCard (R10), así que aquí no se vuelve a escapar nada:
// duplicar el escapado rompería el marcado de las fichas insertadas.
function renderCategoryText(category, rawText) {
  const container = document.getElementById('category-text');
  if (!container) return;

  const key = category ? readText(category.slug) : '';
  let html = '';

  if (category && typeof rawText === 'string' && rawText.trim() !== '') {
    const parsed = parseCategoryText(rawText);

    if (parsed.isValid) {
      // El h1 se descarta ANTES de insertar fichas: un [producto] dentro del encabezado que ya
      // está en la cabecera no debe consumir un producto del catálogo (R7 asigna por orden los
      // marcadores que se van a mostrar en el cuerpo).
      html = injectProductMarkers(stripCategoryHeadingLines(parsed.html), productsInCategory(key));
    }
  }

  if (html.trim() === '') {
    container.innerHTML = '';
    container.hidden = true;
    return;
  }

  container.innerHTML = html;

  // La ficha es un elemento de bloque. Cuando el marcador cae en mitad de un párrafo, el
  // navegador cierra el <p> al encontrarla y el resto de la frase queda como texto suelto en el
  // contenedor: heredaría otro color y se quedaría sin el ritmo de párrafo. Ese fragmento se
  // reenvuelve en un <p> para que el texto siga leyéndose con el mismo estilo (R1), y el <p>
  // vacío que puede dejar un marcador aislado se retira para no dejar un hueco (R8: sin huecos).
  [...container.childNodes].forEach((node) => {
    if (node.nodeType === 3 && node.textContent.trim() !== '') {
      const paragraph = document.createElement('p');
      container.insertBefore(paragraph, node);
      paragraph.appendChild(node);
    }
  });

  [...container.querySelectorAll(':scope > p')].forEach((paragraph) => {
    if (paragraph.textContent.trim() === '' && !paragraph.querySelector('img, h3, a')) {
      paragraph.remove();
    }
  });

  container.hidden = false;
}

// ============================================================================
// Recuperación tras un fallo de carga (R20, R21, R22, R23)
// ============================================================================

// R30, R31: actualizar el marcado estructurado al renderizar la portada.
// Se declara aquí para que se regenere cada vez que la vista cambia.
function renderHomeView() {
  if (dataFlows.catalog.status === 'error') {
    renderState('error', { target: 'featured-state' });
    updateStructuredData([], null);
    return 'error';
  }

  renderState(null, { target: 'featured-state' });
  renderFeaturedBlock(siteState.products);
  // R30: para la portada, los productos visibles son los destacados (máximo 2, seleccionados por carga)
  const featured = selectFeaturedProducts(siteState.products);
  updateStructuredData(featured);
  return 'list';
}

// R19 en su forma mínima: un identificador desconocido cae en la categoría predeterminada, y la
// cabecera se pinta con la categoría que se muestra, no con la solicitada. T13 utiliza
// resolveCategorySlug con la cadena de reglas completa. Sin configuración no hay categoría que
// resolver y el identificador de la URL se conserva tal cual: el estado que corresponda lo decide
// el render (R20).
function resolveActiveCategory() {
  const requested = readText(new URLSearchParams(window.location.search).get('slug'));
  const config = siteState.config;

  if (!config) return { active: null, slug: requested };

  const slug = resolveCategorySlug(requested, config);

  let active = null;
  if (slug && config.categoryIndex) {
    active = config.categoryIndex.get(slug) || null;
  }

  return { active, slug };
}

// R23, R24: estado global de la configuración en #site-state. A diferencia de los estados de
// listado, este contenedor no declara data-state-for, de modo que renderState no oculta ningún
// listado: el catálogo sigue visible mientras se comunica el fallo (R24). Solo se pinta cuando la
// configuración ha fallado y el catálogo no; si fallan los dos, manda el estado del listado y aquí
// no se apila un segundo mensaje de error. Sin contenedor (páginas legales) no se hace nada.
function renderSiteConfigState() {
  if (!document.getElementById('site-state')) return;

  const configFailed = dataFlows.config.status === 'error';
  const catalogFailed = dataFlows.catalog.status === 'error';

  if (configFailed && !catalogFailed) {
    renderState('error', { target: 'site-state' });
  } else {
    renderState(null, { target: 'site-state' });
  }
}

// R12, R17: la navegación principal se repinta desde la configuración con la categoría activa
// marcada. Sin configuración no hay enlaces que generar y se conserva la entrada de inicio que
// trae el HTML. Único punto por el que pasa el marcado de la navegación.
function paintNav(activeSlug) {
  const navContainer = document.querySelector('.main-nav');
  if (!navContainer || !siteState.config) return;

  navContainer.innerHTML = renderCategoryNav(siteState.config.categories, readText(activeSlug));
}

// R13, R16: la vista activa se deriva de la URL en cada repintado, nunca de una variable
// mutable, de modo que la pantalla y la barra de direcciones no pueden desincronizarse.
function currentViewName() {
  const fileName = window.location.pathname.slice(window.location.pathname.lastIndexOf('/') + 1);

  if (fileName === 'categoria.html') return 'category';

  if (fileName === '' || fileName === 'index.html') {
    const slug = readText(new URLSearchParams(window.location.search).get('slug'));
    return slug ? 'category' : 'home';
  }

  return 'home';
}

// Las dos vistas del shell son mutuamente excluyentes. En la página de categoría no existen,
// así que la conmutación queda sin efecto.
function applyViewVisibility(view) {
  const homeView = document.getElementById('home-view');
  const categoryView = document.getElementById('category-view');

  if (homeView) homeView.hidden = view !== 'home';
  if (categoryView) categoryView.hidden = view !== 'category';
}

// Repintado de la vista activa. La acción de reinicio solo sabe qué botón se pulsó, no qué vista hay
// delante, así que la URL decide qué pintarse; si los datos siguen sin cargar, el propio
// render vuelve a resolver el estado y deja el mismo estado de error a la vista.
function renderCurrentView() {
  const view = currentViewName();
  viewState.page = view;

  renderSiteConfigState();
  applyViewVisibility(view);

  if (view === 'category') {
    // Guarda: sin configuración no hay categorías que resolver ni marcador que pintar.
    const { active, slug } = resolveActiveCategory();

    // R19: la URL se canonicaliza antes de pintar, para que los metadatos que renderCategoryView
    // actualiza en cada repintado (R33, R34) ya reflejen el identificador corregido.
    ensureCanonicalSlug(slug);
    renderCategoryPage(active);
    renderCategoryView(slug);
    paintNav(slug);
    return;
  }

  renderHomeView();
  // La portada no tiene categoría: updateMeta compone "categoría | sitio" y con la entrada
  // vacía escribiría solo el nombre, perdiendo el sufijo. Por eso se le pasa el título completo con
  // `fullTitle`, de modo que el título del documento y el og:title compartible coincidan y un ida y
  // vuelta a la portada no cambie el título de la página. El sufijo es la etiqueta del sitio
  // (site.tagline), no un literal de plantilla: R10 exige que el texto venga de la configuración.
  // Sin configuración no hay nada que componer y la reserva razonable la aplica updateMeta.
  const siteName = readText(siteState.config?.site?.name);
  const siteTagline = readText(siteState.config?.site?.tagline);
  updateMeta({
    title: '',
    description: siteTagline,
    image: '',
    url: window.location.href,
    fullTitle: siteName && siteTagline ? `${siteName} | ${siteTagline}` : siteName || siteTagline
  });
  paintNav('');
}

// El botón se deshabilita mientras corre la carga y se rehabilita al terminar. El contenedor del
// estado se marca como ocupado para que las tecnologías de asistencia sepan que hay una acción en
// curso sin que el mensaje de error desaparezca antes de tiempo: R23 solo lo retira si el reintento
// tiene éxito, y ese repintado es el que vuelve a quitar aria-busy. aria-disabled acompaña al
// atributo disabled para que el estado no dependa solo del aspecto.
function setRetryBusy(trigger, busy) {
  if (!trigger) return;

  const container = trigger.closest('.state');

  trigger.disabled = busy;

  if (busy) {
    trigger.setAttribute('aria-disabled', 'true');
    if (container) container.setAttribute('aria-busy', 'true');
    return;
  }

  trigger.removeAttribute('aria-disabled');
  if (container) container.removeAttribute('aria-busy');
}

// R23: la acción de reinicio relanza el flujo de carga completo. loadSiteData es el punto único de
// arranque, el mismo del arranque de la página: repite los dos flujos con sus tres intentos y sus
// esperas (R22), vuelve a validar el catálogo y vuelve a registrar el aviso por consola (R26). Si
// alguno de los dos datos era el que faltaba, el estado de error desaparece y aparece el contenido,
// el estado vacío o el de disponibilidad, según lo que corresponda ahora (R23); si el reintento
// vuelve a fallar, el estado de error se repinta con un botón nuevo, ya habilitado, porque este
// nodo habrá desaparecido con el repintado anterior.
async function runRetry(trigger) {
  if (retryState.running) return;

  retryState.running = true;
  setRetryBusy(trigger, true);

  try {
    await loadSiteData();

    // Con la configuración recuperada vuelven el tema y los textos del esqueleto, que se habían
    // quedado sin inyectar: el reinicio devuelve el sitio entero, no solo el listado (R10, R24).
    if (siteState.config) applyConfig(siteState.config);

    renderCurrentView();
  } finally {
    retryState.running = false;
    setRetryBusy(trigger, false);
  }
}

// El manejador se delega en el documento porque el botón lo crea y lo borra cada pintado del estado:
// colgarlo del nodo valdría solo hasta el primer reintento. Se atiende el clic, que es lo que llega
// también desde la activación con teclado de un <button> nativo.
function onStateActionClick(event) {
  const origin = event.target;
  if (!origin || typeof origin.closest !== 'function') return;

  const trigger = origin.closest('[data-state-action="retry"]');
  if (!trigger) return;

  event.preventDefault();
  runRetry(trigger);
}

async function initHomePage() {
  const view = currentViewName();
  viewState.page = view;
  applyViewVisibility(view);
  renderState('loading', { target: view === 'category' ? 'category-state' : 'featured-state' });

  await loadSiteData();

  if (siteState.config) applyConfig(siteState.config);

  // El repintado final deriva la vista de la URL y pinta la navegación con el enlace que
  // corresponda: "Inicio" en la portada y la categoría activa si la URL trae un slug. El título lo
  // fija renderCurrentView vía updateMeta, con el mismo fullTitle de la portada: fijarlo aquí
  // duplicaba la composición y escribía un literal de plantilla (R10).
  renderCurrentView();
}

async function initCategoryPage() {
  viewState.page = 'category';
  applyViewVisibility('category');
  renderState('loading', { target: 'category-state' });

  await loadSiteData();

  if (siteState.config) applyConfig(siteState.config);

  // El marcador activo sale del slug resuelto, nunca del predeterminado: al cargar
  // categoria.html?slug=... la navegación debe resaltar esa categoría (R17).
  const { slug } = resolveActiveCategory();
  paintNav(slug);

  renderCurrentView();
}

async function initLegalPage() {
  viewState.page = 'legal';
  resetDiscarded();
  const config = await startConfigFlow();

  if (config.status === 'ready') {
    siteState.config = normalizeConfig(config.data);
    applyConfig(siteState.config);
    reportDiscarded(siteState.config.discarded);
  }

  // Navegación de categorías desde la configuración (mismo principio que las otras vistas).
  // En las páginas legales ninguna categoría es la activa, así que "Inicio" lleva la señal.
  paintNav('');
}

document.addEventListener('DOMContentLoaded', () => {
  // Un único manejador para todos los botones de reinicio de las dos vistas, activo desde la primera
  // visita y sin que ningún estado tenga que registrar su propio botón (R23).
  document.addEventListener('click', onStateActionClick);

  // Un único manejador de navegación, para clic y para la activación con Enter (que el navegador
  // emite como clic): dos manejadores para la misma acción crearían dos entradas de historial (R15).
  document.addEventListener('click', onNavigateClick);

  // Los rótulos del banner de cookies se resuelven antes de cargar nada: el banner puede mostrarse
  // sin configuración y sus botones siempre necesitan nombre accesible.
  applyCookieTexts();

  // Registro del evento popstate para navegación con botones atrás/adelante (R16)
  window.addEventListener('popstate', onPopState);

  const path = window.location.pathname.split('/').pop() || 'index.html';

  if (path === 'index.html' || path === '') {
    initHomePage();
  } else if (path === 'categoria.html') {
    initCategoryPage();
  } else {
    initLegalPage();
  }
});
