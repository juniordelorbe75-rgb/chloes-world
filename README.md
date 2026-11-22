# Chloe’s World

Tienda con catálogo real, panel `/admin`, fotos, precios en pesos dominicanos, existencias, tallas/opciones, pedidos y configuración de WhatsApp. No incluye productos ficticios. La administradora sube los suyos desde el teléfono o una computadora.

## Alojamiento independiente de la PC

El mismo servicio de Render sirve la web y la API. Base de datos SQLite, sesiones y fotos se almacenan en el disco persistente montado en `/var/data`. Requiere un único proceso/instancia. Apagar la PC no afecta al servicio una vez desplegado en Render.

El `render.yaml` configura un servicio `0.5c-512mb` y un disco de 1 GB. Precio consultado el 22 de noviembre de 2026: US$7/mes + US$0.25/GB/mes, antes de impuestos, ancho de banda o costos adicionales. Revisa el estado del despliegue en Render antes de anunciar la tienda.

No desplegar con el almacenamiento efímero del plan gratuito: las fotos y la base de datos necesitan el disco persistente.

## Desplegar

1. Usar el repositorio GitHub de este proyecto y subir esta carpeta, sin `.env`, `data/`, tokens ni datos de clientes. No usar otros repositorios de tus proyectos.
2. En Render, dentro de `My Workspace`, crear un Blueprint a partir de ese repositorio y revisar `render.yaml`.
3. Render generará `ADMIN_PASSWORD` automáticamente. Consulta su valor privadamente en Environment del servicio; no la publiques. El usuario predeterminado es `admin`, configurable con `ADMIN_USERNAME`. No enviar la contraseña por chat.
4. Confirmar el plan y el disco persistente antes de aplicar el Blueprint.
5. Esperar a que el despliegue termine. Comprobar `/health`, que `/api/store` responde y que `/admin` permite iniciar sesión.
6. En el panel, abrir «Mi tienda», añadir WhatsApp con código de país, contacto y condiciones de entrega/pago.
7. Subir productos reales con fotos, precio y existencias. Activar «Recibir pedidos» cuando todo esté listo.
8. Hacer un pedido de verificación y comprobarlo en el panel. Cancelarlo para devolver las unidades al inventario. Después verificar un reinicio y confirmar que productos y fotos permanecen.

El dominio gratuito de Render tendrá HTTPS. Un dominio propio se puede conectar después.

## Uso del panel

- Nuevo producto: nombre, categoría, precio RD$, unidades, descripción y de una a seis fotos JPG/PNG/WebP, máximo 5 MB por foto.
- Tallas u opciones: escribirlas separadas por comas. Las existencias son totales por producto, no por talla. Si necesitas inventario independiente, crea un producto por talla.
- Editar: cambiar fotos, precio, existencias o visibilidad. Archivar retira el producto de la tienda y preserva el historial de pedidos.
- Pedidos: revisar nombre, teléfono, entrega, productos y subtotal. Cambiar a confirmado, preparando o entregado; cancelar devuelve las unidades una sola vez.
- Los pedidos pendientes reservan unidades por 24 horas. Al pasar ese plazo sin confirmación se marcan expirados y se devuelve el inventario en la siguiente solicitud al servidor. Los confirmados no expiran automáticamente.
- El panel se actualiza al abrirse y con «Actualizar pedidos». No envía notificaciones externas; hay que revisar los pedidos.

## Pagos y envío

Los clientes pueden enviar pedidos reales que quedan guardados. Se calcula el subtotal con los precios del servidor y se descuenta inventario de forma transaccional. El cliente puede contactar por WhatsApp para coordinar pago y entrega. No se cargan tarjetas ni se confirma un pago automático. El envío se acuerda antes de confirmar el pedido.

## Seguridad y conservación

La administración requiere contraseña. Las sesiones duran ocho horas y usan cookies HttpOnly, SameSite=Strict y Secure en producción; los cambios requieren token CSRF. Hay límites de intentos, validación de uploads y bloqueo de solicitudes desde otros sitios. No se publican datos de clientes en el catálogo.

Conservar una copia externa periódica de base de datos y fotos. Las instantáneas de Render no sustituyen una estrategia completa de respaldo y restauración de SQLite. Antes de modificar almacenamiento, exportar SQLite con su API de backup y copiar `uploads/` durante una pausa de escrituras. Nunca copiar solo `store.db` si SQLite está escribiendo en WAL.

Rotar `ADMIN_PASSWORD` en Render requiere reinicio. Las sesiones existentes deben revocarse si se sospecha acceso no autorizado; borrar los registros de `sessions` mediante un procedimiento administrativo autorizado.

## Desarrollo local

Node.js 24 o posterior, sin dependencias externas. Copiar `.env.example` a `.env`, definir una contraseña privada, ejecutar `npm start`. La dirección predeterminada es `http://127.0.0.1:8011`. Los datos locales van en `data/`; no representan el servicio alojado.

`npm test` ejecuta pruebas de autenticación, CSRF, productos, fotos, persistencia, pedidos, inventario, reintentos idempotentes, cancelaciones y privacidad. Las pruebas utilizan datos temporales y no publican recursos ni cobran dinero.
