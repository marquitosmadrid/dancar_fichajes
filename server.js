// server.js
const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const xlsx = require('xlsx');

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de EJS y middlewares
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuración de sesiones
app.use(session({
    secret: 'clave_secreta_control_horario',
    resave: false,
    saveUninitialized: false
}));

// Inicialización de la Base de Datos con LibSQL (compatible con Turso y SQLite local)
const db = createClient({
    url: process.env.TURSO_DATABASE_URL || 'file:database.sqlite',
    authToken: process.env.TURSO_AUTH_TOKEN,
});

async function inicializarTablas() {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            rol TEXT CHECK(rol IN ('trabajador', 'admin')) NOT NULL
        )`);

        await db.execute(`CREATE TABLE IF NOT EXISTS fichajes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario_id INTEGER,
            tipo TEXT CHECK(tipo IN ('entrada', 'salida')) NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(usuario_id) REFERENCES usuarios(id)
        )`);

        const result = await db.execute(`SELECT COUNT(*) as count FROM usuarios`);
        const count = result.rows[0].count;

        if (count === 0) {
            const hashAdmin = await bcrypt.hash('admin123', 10);
            const hashTrabajador = await bcrypt.hash('trabajador123', 10);
            
            await db.execute({
                sql: `INSERT INTO usuarios (nombre, username, password, rol) VALUES (?, ?, ?, ?)`,
                args: ['Administrador', 'admin', hashAdmin, 'admin']
            });
            await db.execute({
                sql: `INSERT INTO usuarios (nombre, username, password, rol) VALUES (?, ?, ?, ?)`,
                args: ['Trabajador Ejemplo', 'trabajador', hashTrabajador, 'trabajador']
            });
            console.log('Usuarios por defecto creados (admin / admin123 y trabajador / trabajador123).');
        }
        console.log('Conectado y tablas inicializadas correctamente en la base de datos.');
    } catch (err) {
        console.error('Error al inicializar la base de datos:', err.message);
    }
}

inicializarTablas();

// Middlewares de autenticación
function verificarAuth(req, res, next) {
    if (req.session && req.session.usuario) {
        return next();
    }
    res.redirect('/login');
}

function verificarAdmin(req, res, next) {
    if (req.session && req.session.usuario && req.session.usuario.rol === 'admin') {
        return next();
    }
    res.status(403).send("Acceso denegado. Se requieren permisos de administrador.");
}

// Rutas de Autenticación
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.execute({
            sql: `SELECT * FROM usuarios WHERE username = ?`,
            args: [username]
        });
        const usuario = result.rows[0];

        if (!usuario) {
            return res.render('login', { error: 'Credenciales incorrectas.' });
        }
        const match = await bcrypt.compare(password, usuario.password);
        if (!match) {
            return res.render('login', { error: 'Credenciales incorrectas.' });
        }
        req.session.usuario = usuario;
        if (usuario.rol === 'admin') {
            res.redirect('/admin');
        } else {
            res.redirect('/');
        }
    } catch (err) {
        return res.render('login', { error: 'Error en base de datos.' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// Ruta para ver el panel del trabajador (Protegido por sesión)
app.get('/', verificarAuth, async (req, res) => {
    if (req.session.usuario.rol === 'admin') {
        return res.redirect('/admin');
    }
    const usuarioId = req.session.usuario.id; 

    try {
        const userResult = await db.execute({
            sql: `SELECT * FROM usuarios WHERE id = ?`,
            args: [usuarioId]
        });
        const usuario = userResult.rows[0];
        if (!usuario) return res.status(500).send("Error al cargar el usuario.");

        const fichajesResult = await db.execute({
            sql: `SELECT * FROM fichajes WHERE usuario_id = ? ORDER BY timestamp ASC`,
            args: [usuarioId]
        });
        const fichajes = fichajesResult.rows;

        res.render('trabajador', { usuario, fichajes, errorDuplicado: null, datosPendientes: null });
    } catch (err) {
        return res.status(500).send("Error al cargar los datos.");
    }
});

app.post('/fichar', verificarAuth, async (req, res) => {
    const usuario_id = req.session.usuario.id;
    const { tipo, fecha, hora, accion_duplicado, fichaje_existente_id } = req.body;

    if (!tipo) return res.status(400).send("Datos incompletos.");

    let timestampFinal;
    let tipoLimpio = tipo.replace('_retro', '').replace('_forzar', '');

    if (tipo.includes('retro')) {
        if (!fecha || !hora) return res.status(400).send("Debes indicar fecha y hora para el fichaje retroactivo.");
        timestampFinal = `${fecha} ${hora}:00`;
    } else {
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const hh = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        timestampFinal = `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
    }

    const fechaSoloDia = timestampFinal.split(' ')[0];

    try {
        if (accion_duplicado === 'modificar' && fichaje_existente_id) {
            await db.execute({
                sql: `UPDATE fichajes SET timestamp = ? WHERE id = ?`,
                args: [timestampFinal, fichaje_existente_id]
            });
            return res.redirect('/');
        }

        const queryCheck = `SELECT * FROM fichajes WHERE usuario_id = ? AND tipo = ? AND date(timestamp) = ?`;
        const checkResult = await db.execute({
            sql: queryCheck,
            args: [usuario_id, tipoLimpio, fechaSoloDia]
        });
        const row = checkResult.rows[0];

        if (row && accion_duplicado !== 'crear_ambos') {
            const userResult = await db.execute({
                sql: `SELECT * FROM usuarios WHERE id = ?`,
                args: [usuario_id]
            });
            const usuario = userResult.rows[0];

            const fichajesResult = await db.execute({
                sql: `SELECT * FROM fichajes WHERE usuario_id = ? ORDER BY timestamp ASC`,
                args: [usuario_id]
            });
            const fichajes = fichajesResult.rows;

            return res.render('trabajador', {
                usuario,
                fichajes,
                errorDuplicado: `Ya tienes registrado un fichaje de '${tipoLimpio}' para el día ${fechaSoloDia}.`,
                datosPendientes: { usuario_id, tipo: tipoLimpio, timestampFinal, fichaje_existente_id: row.id }
            });
        }

        await db.execute({
            sql: `INSERT INTO fichajes (usuario_id, tipo, timestamp) VALUES (?, ?, ?)`,
            args: [usuario_id, tipoLimpio, timestampFinal]
        });
        res.redirect('/');
    } catch (err) {
        return res.status(500).send("Error en base de datos.");
    }
});

// Endpoint para eliminar fichaje por parte del trabajador (solo sus propios fichajes)
app.post('/fichajes/eliminar', verificarAuth, async (req, res) => {
    const { fichaje_id } = req.body;
    try {
        await db.execute({
            sql: `DELETE FROM fichajes WHERE id = ? AND usuario_id = ?`,
            args: [fichaje_id, req.session.usuario.id]
        });
        res.redirect('/');
    } catch (err) {
        return res.status(500).send("Error al eliminar el fichaje.");
    }
});

// Ruta para el panel de administración (Protegido por admin)
app.get('/admin', verificarAdmin, async (req, res) => {
    try {
        const usuariosResult = await db.execute(`SELECT * FROM usuarios`);
        const usuarios = usuariosResult.rows;

        const queryFichajes = `
            SELECT fichajes.*, usuarios.nombre as nombre_trabajador 
            FROM fichajes 
            JOIN usuarios ON fichajes.usuario_id = usuarios.id 
            ORDER BY fichajes.timestamp ASC
        `;
        const fichajesResult = await db.execute(queryFichajes);
        const fichajes = fichajesResult.rows;

        res.render('admin', { usuarios, fichajes, adminUser: req.session.usuario });
    } catch (err) {
        return res.status(500).send("Error al cargar administración.");
    }
});

app.post('/admin/usuario/guardar', verificarAdmin, async (req, res) => {
    const { id, nombre, username, password, rol } = req.body;

    try {
        if (id) {
            if (password && password.trim() !== "") {
                const hash = await bcrypt.hash(password, 10);
                await db.execute({
                    sql: `UPDATE usuarios SET nombre = ?, username = ?, password = ?, rol = ? WHERE id = ?`,
                    args: [nombre, username, hash, rol, id]
                });
            } else {
                await db.execute({
                    sql: `UPDATE usuarios SET nombre = ?, username = ?, rol = ? WHERE id = ?`,
                    args: [nombre, username, rol, id]
                });
            }
        } else {
            if (!password) return res.status(400).send("La contraseña es obligatoria para nuevos usuarios.");
            const hash = await bcrypt.hash(password, 10);
            await db.execute({
                sql: `INSERT INTO usuarios (nombre, username, password, rol) VALUES (?, ?, ?, ?)`,
                args: [nombre, username, hash, rol]
            });
        }
        res.redirect('/admin');
    } catch (err) {
        return res.status(500).send("Error al guardar usuario.");
    }
});

// Endpoint para importar fichajes mediante Excel
app.post('/admin/fichajes/importar', verificarAdmin, upload.single('archivo_excel'), async (req, res) => {
    const { usuario_id } = req.body;

    if (!usuario_id || !req.file) {
        return res.status(400).send("Faltan el usuario o el archivo Excel.");
    }

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_json(sheet);

        for (const row of rows) {
            // Normalizar las claves de las columnas por si tienen mayúsculas o espacios
            const fecha = row.fecha || row.Fecha;
            const hora = row.hora || row.Hora;
            let tipo = row.tipo || row.Tipo;

            if (fecha && hora && tipo) {
                tipo = String(tipo).trim().toLowerCase();
                if (tipo === 'entrada' || tipo === 'salida') {
                    // Formatear la fecha correctamente (maneja tanto formato YYYY-MM-DD como números de serie de Excel si aplica)
                    let fechaStr = fecha;
                    if (typeof fecha === 'number') {
                        const parsedDate = xlsx.SSF.parse_date_code(fecha);
                        fechaStr = `${parsedDate.y}-${String(parsedDate.m).padStart(2, '0')}-${String(parsedDate.d).padStart(2, '0')}`;
                    }

                    // Asegurar formato de hora HH:MM:SS
                    let horaStr = String(hora).trim();
                    if (horaStr.length === 5) horaStr += ':00';

                    const timestampFinal = `${fechaStr} ${horaStr}`;

                    await db.execute({
                        sql: `INSERT INTO fichajes (usuario_id, tipo, timestamp) VALUES (?, ?, ?)`,
                        args: [usuario_id, tipo, timestampFinal]
                    });
                }
            }
        }

        res.redirect('/admin');
    } catch (err) {
        console.error("Error al procesar el archivo Excel:", err);
        return res.status(500).send("Error al procesar el fichero Excel.");
    }
});

// Endpoint para que el administrador modifique un fichaje directamente
app.post('/admin/editar', verificarAdmin, async (req, res) => {
    const { fichaje_id, nuevo_timestamp } = req.body;

    if (!fichaje_id || !nuevo_timestamp) {
        return res.status(400).send("Faltan datos para realizar la actualización.");
    }

    try {
        await db.execute({
            sql: `UPDATE fichajes SET timestamp = ? WHERE id = ?`,
            args: [nuevo_timestamp, fichaje_id]
        });
        res.redirect('/admin');
    } catch (err) {
        return res.status(500).send("Error al actualizar el fichaje.");
    }
});

// Endpoint para que el administrador elimine cualquier fichaje
app.post('/admin/fichajes/eliminar', verificarAdmin, async (req, res) => {
    const { fichaje_id } = req.body;

    if (!fichaje_id) {
        return res.status(400).send("ID de fichaje no proporcionado.");
    }

    try {
        await db.execute({
            sql: `DELETE FROM fichajes WHERE id = ?`,
            args: [fichaje_id]
        });
        res.redirect('/admin');
    } catch (err) {
        return res.status(500).send("Error al eliminar el fichaje.");
    }
});

// Arrancar servidor
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});