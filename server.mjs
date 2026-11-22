import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash,scryptSync,timingSafeEqual} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,statSync,renameSync} from 'node:fs';
import {resolve,join,extname,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isIP} from 'node:net';

const root=dirname(fileURLToPath(import.meta.url));
const fail=(status,message)=>{const e=Error(message);e.status=status;throw e};
const text=(v,max=500)=>String(v??'').trim().slice(0,max);
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const hash=v=>createHash('sha256').update(v).digest('hex');
const categories=['Dulces','Juegos','Ropa'];
const statuses=['pendiente','confirmado','preparando','entregado','cancelado','expirado'];

export function openStore(dataDir){
  mkdirSync(join(dataDir,'uploads'),{recursive:true});
  const db=new DatabaseSync(join(dataDir,'store.db'));db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,price INTEGER NOT NULL CHECK(price>=0),stock INTEGER NOT NULL CHECK(stock>=0),sizes TEXT NOT NULL DEFAULT '[]',images TEXT NOT NULL DEFAULT '[]',active INTEGER NOT NULL DEFAULT 1,created TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,customer TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL,fulfillment TEXT NOT NULL,notes TEXT NOT NULL,items TEXT NOT NULL,subtotal INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pendiente',created TEXT NOT NULL,request_key TEXT UNIQUE NOT NULL);
  `);
  db.prepare('INSERT OR IGNORE INTO settings VALUES(1,?)').run(JSON.stringify({name:'Chloe’s World',whatsapp:'',delivery:'Envíos y pago a coordinar antes de confirmar el pedido.',contact:'',ordersEnabled:false}));
  return db;
}
export function expirePendingOrders(db,now=Date.now()){
  const before=new Date(now-24*3600000).toISOString();db.exec('BEGIN IMMEDIATE');
  try{const rows=db.prepare("SELECT id,items FROM orders WHERE status='pendiente' AND created<?").all(before);for(const row of rows){for(const item of JSON.parse(row.items))db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(item.quantity,item.id);db.prepare("UPDATE orders SET status='expirado' WHERE id=?").run(row.id)}db.prepare('DELETE FROM sessions WHERE expires<?').run(now);db.exec('COMMIT');return rows.length}catch(e){db.exec('ROLLBACK');throw e}
}
function product(row){return {...row,sizes:JSON.parse(row.sizes),images:JSON.parse(row.images),active:Boolean(row.active)};}
function validateProduct(p,dataDir){
  const name=text(p.name,120),description=text(p.description,3000);
  if(!name||!categories.includes(p.category))fail(400,'Completa el nombre y una categoría válida.');
  if(!integer(p.price,1,100000000)||!integer(p.stock,0,100000))fail(400,'Precio o existencias inválidos.');
  const sizes=[...new Set((Array.isArray(p.sizes)?p.sizes:[]).map(x=>text(x,30)).filter(Boolean))];if(sizes.length>25)fail(400,'Máximo 25 tallas u opciones.');
  const images=[...new Set(Array.isArray(p.images)?p.images:[])];
  if(images.length<1||images.length>6)fail(400,'Sube entre una y seis fotos del producto.');
  for(const image of images){if(typeof image!=='string'||!/^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(image)||!existsSync(join(dataDir,image.slice(1))))fail(400,'La foto no está disponible. Vuelve a subirla.');}
  return {name,description,category:p.category,price:p.price,stock:p.stock,sizes:JSON.stringify(sizes),images:JSON.stringify(images),active:p.active===false?0:1};
}
export function createApp({dataDir=resolve(process.env.DATA_DIR||'./data'),password=process.env.ADMIN_PASSWORD,username=process.env.ADMIN_USERNAME||'admin',production=process.env.NODE_ENV==='production',publicUrl=process.env.PUBLIC_URL||'',db=openStore(dataDir)}={}){
  if(typeof password!=='string'||password.length<16)throw Error('Configura ADMIN_PASSWORD con al menos 16 caracteres.');
  if(production&&dataDir!==resolve('/var/data')&&!process.env.ALLOW_CUSTOM_DATA_DIR)throw Error('En Render configura DATA_DIR=/var/data con un disco persistente.');
  const salt=randomBytes(32),passwordHash=scryptSync(password,salt,32),rates=new Map();let lastMaintenance=0;
  function limit(key,max,window=600000){const now=Date.now();if(rates.size>10000)for(const[k,v]of rates)if(v.until<now)rates.delete(k);const v=rates.get(key);if(!v||v.until<now){rates.set(key,{n:1,until:now+window});return}if(++v.n>max)fail(429,'Demasiados intentos. Espera unos minutos.');}
  const server=createServer(async(req,res)=>{
    const send=(status,value,extra={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...extra});res.end(JSON.stringify(value));};
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(production)res.setHeader('Strict-Transport-Security','max-age=31536000');
    try{
      const url=new URL(req.url,'http://localhost'),path=url.pathname;
      if(Date.now()-lastMaintenance>60000){expirePendingOrders(db);lastMaintenance=Date.now()}
      const forwarded=String(req.headers['x-forwarded-for']||'').split(',').at(-1).trim();
      const ip=production&&process.env.RENDER&&isIP(forwarded)?forwarded:req.socket.remoteAddress||'unknown';
      if(!['GET','HEAD','POST','PUT','DELETE'].includes(req.method))fail(405,'Método no permitido.');
      if(!['GET','HEAD'].includes(req.method)){
        const origin=req.headers.origin;
        const expected=publicUrl?new URL(publicUrl).origin:`${production?'https':'http'}://${req.headers.host}`;
        if(origin&&origin!==expected)fail(403,'Origen no permitido.');
        if(req.headers['sec-fetch-site']==='cross-site')fail(403,'Solicitud no permitida.');
        if(['POST','PUT'].includes(req.method)&&!String(req.headers['content-type']||'').startsWith('application/json'))fail(415,'Usa formato JSON.');
      }
      async function body(max=150000){
        if(Number(req.headers['content-length']||0)>max)fail(413,'El archivo o solicitud es demasiado grande.');
        const chunks=[];let n=0;for await(const chunk of req){n+=chunk.length;if(n>max)fail(413,'El archivo o solicitud es demasiado grande.');chunks.push(chunk)}
        try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'Solicitud JSON inválida.');return value}catch{fail(400,'Solicitud JSON inválida.');}
      }
      const cookie=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('cw_session='))?.slice(11)||'';
      const session=/^[a-f0-9]{64}$/.test(cookie)?db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(hash(cookie),Date.now()):null;
      const admin=()=>{if(!session)fail(401,'Inicia sesión.');if(!['GET','HEAD'].includes(req.method)&&req.headers['x-csrf-token']!==session.csrf)fail(403,'Actualiza el panel e inténtalo de nuevo.');};
      const settings=()=>JSON.parse(db.prepare('SELECT value FROM settings WHERE id=1').get().value);
      if(path==='/health'&&req.method==='GET'){db.prepare('SELECT 1').get();return send(200,{status:'ok',app:'chloes-world'})}
      if(path==='/api/store'&&req.method==='GET')return send(200,{settings:settings(),products:db.prepare('SELECT * FROM products WHERE active=1 ORDER BY id DESC').all().map(product)});
      if(path==='/api/admin/login'&&req.method==='POST'){
        limit('login:'+ip,12);limit('login:global',100);
        const p=await body(5000);const attempt=text(p.password,1000);const candidate=scryptSync(attempt,salt,32);
        if(text(p.username,100)!==username||!timingSafeEqual(candidate,passwordHash))fail(401,'Usuario o contraseña incorrectos.');
        const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
        db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token),csrf,Date.now()+8*3600000);
        return send(200,{csrf}, {'Set-Cookie':`cw_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${production?'; Secure':''}`});
      }
      if(path.startsWith('/api/admin/')){
        admin();
        if(path==='/api/admin/session'&&req.method==='GET')return send(200,{csrf:session.csrf,username});
        if(path==='/api/admin/logout'&&req.method==='POST'){db.prepare('DELETE FROM sessions WHERE token=?').run(session.token);return send(200,{ok:true},{'Set-Cookie':`cw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${production?'; Secure':''}`})}
        if(path==='/api/admin/products'&&req.method==='GET')return send(200,db.prepare('SELECT * FROM products ORDER BY id DESC').all().map(product));
        if(path==='/api/admin/products'&&req.method==='POST'){
          const p=validateProduct(await body(),dataDir),now=new Date().toISOString();
          const result=db.prepare('INSERT INTO products(name,description,category,price,stock,sizes,images,active,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)').run(p.name,p.description,p.category,p.price,p.stock,p.sizes,p.images,p.active,now,now);
          return send(201,product(db.prepare('SELECT * FROM products WHERE id=?').get(result.lastInsertRowid)));
        }
        const productMatch=path.match(/^\/api\/admin\/products\/(\d+)$/);
        if(productMatch&&req.method==='PUT'){
          const id=Number(productMatch[1]);if(!db.prepare('SELECT 1 FROM products WHERE id=?').get(id))fail(404,'Producto no encontrado.');
          const p=validateProduct(await body(),dataDir);db.prepare('UPDATE products SET name=?,description=?,category=?,price=?,stock=?,sizes=?,images=?,active=?,updated=? WHERE id=?').run(p.name,p.description,p.category,p.price,p.stock,p.sizes,p.images,p.active,new Date().toISOString(),id);
          return send(200,product(db.prepare('SELECT * FROM products WHERE id=?').get(id)));
        }
        if(productMatch&&req.method==='DELETE'){const result=db.prepare('UPDATE products SET active=0,updated=? WHERE id=?').run(new Date().toISOString(),Number(productMatch[1]));if(!result.changes)fail(404,'Producto no encontrado.');return send(200,{ok:true})}
        if(path==='/api/admin/images'&&req.method==='POST'){
          limit('upload:'+session.token,40,60000);
          const p=await body(7500000);const match=typeof p.data==='string'&&p.data.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);if(!match)fail(400,'Solo se aceptan fotos JPG, PNG o WebP.');
          const image=Buffer.from(match[2],'base64');if(image.length<24||image.length>5*1024*1024)fail(400,'La foto debe pesar como máximo 5 MB.');
          const valid=match[1]==='jpeg'?image.subarray(0,3).equals(Buffer.from([255,216,255]))&&image.subarray(-2).equals(Buffer.from([255,217])):match[1]==='png'?image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):image.toString('ascii',0,4)==='RIFF'&&image.toString('ascii',8,12)==='WEBP';
          if(!valid)fail(400,'El contenido del archivo no corresponde a una foto válida.');
          const name=randomBytes(16).toString('hex')+'.'+(match[1]==='jpeg'?'jpg':match[1]);const target=join(dataDir,'uploads',name);writeFileSync(target+'.tmp',image);renameSync(target+'.tmp',target);return send(201,{url:'/uploads/'+name});
        }
        if(path==='/api/admin/settings'&&req.method==='GET')return send(200,settings());
        if(path==='/api/admin/settings'&&req.method==='PUT'){
          const p=await body(),whatsapp=text(p.whatsapp,20).replace(/[\s+()-]/g,'');if(whatsapp&&!/^\d{10,15}$/.test(whatsapp))fail(400,'WhatsApp debe incluir el código de país, por ejemplo 1809…');
          const value={name:text(p.name,80)||'Chloe’s World',whatsapp,delivery:text(p.delivery,1000),contact:text(p.contact,500),ordersEnabled:p.ordersEnabled===true};db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(value));return send(200,value);
        }
        if(path==='/api/admin/orders'&&req.method==='GET')return send(200,db.prepare('SELECT * FROM orders ORDER BY created DESC LIMIT 500').all().map(o=>({...o,items:JSON.parse(o.items)})));
        const orderMatch=path.match(/^\/api\/admin\/orders\/([A-F0-9]{12})$/);
        if(orderMatch&&req.method==='PUT'){
          const p=await body();if(!statuses.includes(p.status))fail(400,'Estado inválido.');
          db.exec('BEGIN IMMEDIATE');try{
            const o=db.prepare('SELECT * FROM orders WHERE id=?').get(orderMatch[1]);if(!o)fail(404,'Pedido no encontrado.');
            if(o.status===p.status){db.exec('COMMIT');return send(200,{ok:true})}
            const allowed={pendiente:['confirmado','cancelado'],confirmado:['preparando','cancelado'],preparando:['entregado','cancelado'],entregado:[],cancelado:[],expirado:[]};if(!allowed[o.status].includes(p.status))fail(409,'Ese cambio de estado no está permitido.');
            if(p.status==='cancelado')for(const item of JSON.parse(o.items))db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(item.quantity,item.id);
            db.prepare('UPDATE orders SET status=? WHERE id=?').run(p.status,o.id);db.exec('COMMIT');return send(200,{ok:true});
          }catch(e){db.exec('ROLLBACK');throw e}
        }
        fail(404,'Ruta no encontrada.');
      }
      if(path==='/api/orders'&&req.method==='POST'){
        limit('orders:'+ip,15);const p=await body(20000);const config=settings();if(!config.ordersEnabled)fail(409,'Todavía no estamos recibiendo pedidos. Vuelve pronto.');
        const customer=text(p.customer,100),phone=text(p.phone,30),address=text(p.address,600),notes=text(p.notes,1000),fulfillment=p.fulfillment;
        if(customer.length<2||!/^\+?[\d ()-]{8,30}$/.test(phone)||!['envio','recogida'].includes(fulfillment)||fulfillment==='envio'&&address.length<8)fail(400,'Completa tu nombre, teléfono y dirección de entrega.');
        if(!/^[a-f0-9-]{20,64}$/.test(p.requestKey||''))fail(400,'Actualiza la página para preparar tu pedido.');
        if(!Array.isArray(p.items)||!p.items.length||p.items.length>30)fail(400,'Tu bolsa debe contener entre 1 y 30 artículos.');
        db.exec('BEGIN IMMEDIATE');try{
          const old=db.prepare('SELECT id,subtotal FROM orders WHERE request_key=?').get(p.requestKey);if(old){db.exec('COMMIT');return send(200,old)}
          const items=[],seen=new Set();let subtotal=0;
          for(const item of p.items){
            if(!integer(item.id,1,Number.MAX_SAFE_INTEGER)||!integer(item.quantity,1,50))fail(400,'Cantidad inválida.');
            const key=item.id+':'+text(item.size,30);if(seen.has(key))fail(400,'Artículo repetido.');seen.add(key);
            const row=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(item.id);if(!row)fail(409,'Un producto ya no está disponible. Actualiza tu bolsa.');
            const options=JSON.parse(row.sizes),size=text(item.size,30);if(options.length&&!options.includes(size))fail(400,'Selecciona una talla u opción válida para '+row.name);if(!options.length&&size)fail(400,'Este producto no tiene opciones.');
            const changed=db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND stock>=?').run(item.quantity,item.id,item.quantity);if(!changed.changes)fail(409,'No hay suficientes unidades de '+row.name+'.');
            subtotal+=row.price*item.quantity;items.push({id:row.id,name:row.name,price:row.price,quantity:item.quantity,size});
          }
          const id=randomBytes(6).toString('hex').toUpperCase();db.prepare('INSERT INTO orders(id,customer,phone,address,fulfillment,notes,items,subtotal,created,request_key) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,customer,phone,address,fulfillment,notes,JSON.stringify(items),subtotal,new Date().toISOString(),p.requestKey);db.exec('COMMIT');return send(201,{id,subtotal});
        }catch(e){db.exec('ROLLBACK');throw e}
      }
      if(path.startsWith('/api/'))fail(404,'Ruta no encontrada.');
      if(!['GET','HEAD'].includes(req.method))fail(405,'Método no permitido.');
      let file;
      if(/^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(path))file=join(dataDir,path.slice(1));
      else{const rel=path==='/'?'index.html':path==='/admin'?'admin.html':decodeURIComponent(path).replace(/^\//,'');file=resolve(root,'public',rel);if(!file.startsWith(resolve(root,'public')+'/')&&!file.startsWith(resolve(root,'public')+'\\'))fail(403,'Acceso no permitido.');}
      if(!existsSync(file)||!statSync(file).isFile())fail(404,'Archivo no encontrado.');
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream';
      if(!file.endsWith('.html'))res.setHeader('Cache-Control',path.startsWith('/uploads/')?'public,max-age=31536000,immutable':'public,max-age=300');
      res.writeHead(200,{'Content-Type':mime});res.end(req.method==='HEAD'?undefined:readFileSync(file));
    }catch(e){if(!res.headersSent)send(e.status||500,{error:e.status?e.message:'No se pudo completar la operación. Inténtalo de nuevo.'});else res.end();}
  });
  server.requestTimeout=30000;server.headersTimeout=15000;return {server,db};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {server,db}=createApp();server.listen(Number(process.env.PORT||8011),process.env.RENDER?'0.0.0.0':'127.0.0.1',()=>console.log('Chloe’s World: servidor iniciado.'));
  const stop=()=>server.close(()=>{db.close();process.exit(0)});process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
