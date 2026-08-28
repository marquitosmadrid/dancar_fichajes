// server.js
const express = require('express');
const sqlite3 = express ? require('sqlite3').verbose() : null;
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');

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

// Inicialización de la Base de Datos SQLite
const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error al conectar con la base de datos:', err.message);
    } else {
        console.log('Conectado a la base de datos SQLite.');
        inicializarTablas();
    }
});

function inicializarTablas() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            rol TEXT CHECK(rol IN ('trabajador', 'admin')) NOT NULL
        )`, () => {
            db.get(`SELECT COUNT(*) as count FROM usuarios`, async (err, row) => {
                if (!err && row && row.count === 0) {
                    const hashAdmin = await bcrypt.hash('admin123', 10);
                    const hashTrabajador = await bcrypt.hash('trabajador123', 10);
                    db.run(`INSERT INTO usuarios (nombre, username, password, rol) VALUES (?, ?, ?, ?)`, ['Administrador', 'admin', hashAdmin, 'admin']);
                    db.run(`INSERT INTO usuarios (nombre, username, password, rol) VALUES (?, ?, ?, ?)`, ['Trabajador Ejemplo', 'trabajador', hashTrabajador, 'trabajador']);
                    console.log('Usuarios por defecto creados (admin / admin123 y trabajador / trabajador123).');
                }
            });
        });

        db.run(`CREATE TABLE IF NOT EXISTS fichajes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario_id INTEGER,
            tipo TEXT CHECK(tipo IN ('entrada', 'salida')) NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(usuario_id) REFERENCES usuarios(id)
        )`);
    });
}

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

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM usuarios WHERE username = ?`, [username], async (err, usuario) => {
        if (err || !usuario) {
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
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// Ruta para ver el panel del trabajador (Protegido por sesión)
app.get('/', verificarAuth, (req, res) => {
    if (req.session.usuario.rol === 'admin') {
        return res.redirect('/admin');
    }
    const usuarioId = req.session.usuario.id; 

    db.get(`SELECT * FROM usuarios WHERE id = ?`, [usuarioId], (err, usuario) => {
        if (err || !usuario) return res.status(500).send("Error al cargar el usuario.");

        db.all(`SELECT * FROM fichajes WHERE usuario_id = ? ORDER BY timestamp ASC`, [usuarioId], (err, fichajes) => {
            if (err) return res.status(500).send("Error al cargar los fichajes.");
            res.render('trabajador', { usuario, fichajes, errorDuplicado: null, datosPendientes: null });
        });
    });
});

app.post('/fichar', verificarAuth, (req, res) => {
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

    if (accion_duplicado === 'modificar' && fichaje_existente_id) {
        db.run(`UPDATE fichajes SET timestamp = ? WHERE id = ?`, [timestampFinal, fichaje_existente_id], (err) => {
            if (err) return res.status(500).send("Error al actualizar fichaje duplicado.");
            return res.redirect('/');
        });
        return;
    }

    const queryCheck = `SELECT * FROM fichajes WHERE usuario_id = ? AND tipo = ? AND date(timestamp) = ?`;
    db.get(queryCheck, [usuario_id, tipoLimpio, fechaSoloDia], (err, row) => {
        if (err) return res.status(500).send("Error en base de datos.");

        if (row && accion_duplicado !== 'crear_ambos') {
            db.get(`SELECT * FROM usuarios WHERE id = ?`, [usuario_id], (usuarioErr, usuario) => {
                db.all(`SELECT * FROM fichajes WHERE usuario_id = ? ORDER BY timestamp ASC`, [usuario_id], (fichajesErr, fichajes) => {
                    return res.render('trabajador', {
                        usuario,
                        fichajes,
                        errorDuplicado: `Ya tienes registrado un fichaje de '${tipoLimpio}' para el día ${fechaSoloDia}.`,
                        datosPendientes: { usuario_id, tipo: tipoLimpio, timestampFinal, fichaje_existente_id: row.id }
                    });
                });
            });
            return;
        }

        db.run(`INSERT INTO fichajes (usuario_id, tipo, timestamp) VALUES (?, ?, ?)`, [usuario_id, tipoLimpio, timestampFinal], (err) => {
            if (err) return res.status(500).send("Error al registrar fichaje.");
            res.redirect('/');
        });
    });
});

// Endpoint para eliminar fichaje por parte del trabajador (solo sus propios fichajes)
app.post('/fichajes/eliminar', verificarAuth, (req, res) => {
    const { fichaje_id } = req.body;
    db.run(`DELETE FROM fichajes WHERE id = ? AND usuario_id = ?`, [fichaje_id, req.session.usuario.id], (err) => {
        if (err) return res.status(500).send("Error al eliminar el fichaje.");
        res.redirect('/');
    });
});

// Ruta para el panel de administración (Protegido por admin)
app.get('/admin', verificarAdmin, (req, res) => {
    db.all(`SELECT * FROM usuarios`, [], (err, usuarios) => {
        if (err) return res.status(500).send("Error al cargar los usuarios.");

        const queryFichajes = `
            SELECT fichajes.*, usuarios.nombre as nombre_trabajador 
            FROM fichajes 
            JOIN usuarios ON fichajes.usuario_id = usuarios.id 
            ORDER BY fichajes.timestamp ASC
        `;

        db.all(queryFichajes, [], (err, fichajes) => {
            if (err) return res.status(500).send("Error al cargar administración.");
            res.render('admin', { usuarios, fichajes, adminUser: req.session.usuario });
        });
    });
});

app.post('/admin/usuario/guardar', verificarAdmin, async (req, res) => {
    const { id, nombre, username, password, rol } = req.body;

    if (id) {
        if (password && password.trim() !== "") {
            const hash = await bcrypt.hash(password, 10);
            db.run(`UPDATE usuarios SET nombre = ?, username = ?, password = ?, rol = ? WHERE id = ?`, [nombre, username, hash, rol, id], (err) => {
                if (err) return res.status(500).send("Error al actualizar usuario.");
                res.redirect('/admin');
            });
        } else {
            db.run(`UPDATE usuarios SET nombre = ?, username = ?, rol = ? WHERE id = ?`, [nombre, username, rol, id], (err) => {
                if (err) return res.status(500).send("Error al actualizar usuario.");
                res.redirect('/admin');
            });
        }
    } else {
        if (!password) return res.status(400).send("La contraseña es obligatoria para nuevos usuarios.");
        const hash = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO usuarios (nombre, username, password, rol) VALUES (?, ?, ?, ?)`, [nombre, username, hash, rol], (err) => {
            if (err) return res.status(500).send("Error al crear usuario.");
            res.redirect('/admin');
        });
    }
});

// Endpoint para que el administrador modifique un fichaje directamente
app.post('/admin/editar', verificarAdmin, (req, res) => {
    const { fichaje_id, nuevo_timestamp } = req.body;

    if (!fichaje_id || !nuevo_timestamp) {
        return res.status(400).send("Faltan datos para realizar la actualización.");
    }

    const query = `UPDATE fichajes SET timestamp = ? WHERE id = ?`;

    db.run(query, [nuevo_timestamp, fichaje_id], (err) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Error al actualizar el fichaje.");
        }
        res.redirect('/admin');
    });
});

// Endpoint para que el administrador elimine cualquier fichaje
app.post('/admin/fichajes/eliminar', verificarAdmin, (req, res) => {
    const { fichaje_id } = req.body;

    if (!fichaje_id) {
        return res.status(400).send("ID de fichaje no proporcionado.");
    }

    db.run(`DELETE FROM fichajes WHERE id = ?`, [fichaje_id], (err) => {
        if (err) {
            console.error(err.message);
            return res.status(500).send("Error al eliminar el fichaje.");
        }
        res.redirect('/admin');
    });
});

// Arrancar servidor
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});