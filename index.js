// 🔥 DEVE SER A PRIMEIRA LINHA ABSOLUTA DO ARQUIVO ANTES DOS REQUIRES
process.env.PUPPETEER_CACHE_DIR = require('path').join(__dirname, '.puppeteer-cache');

const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const { parse } = require('csv-parse');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('uploads/imagens')) fs.mkdirSync('uploads/imagens', { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const upload = multer({ dest: 'uploads/' });

const storageImagem = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'uploads/imagens/'); },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname) || '.png';
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'banner-' + uniqueSuffix + ext);
    }
});
const uploadImagem = multer({ storage: storageImagem });

let db;

async function iniciarBanco() {
    db = await open({
        filename: './database.sqlite',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            nome TEXT, 
            login TEXT, 
            senha TEXT, 
            tipo TEXT, 
            status TEXT,
            permissoes TEXT
        );
        CREATE TABLE IF NOT EXISTS carteiras (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, codigo TEXT, status TEXT);
        CREATE TABLE IF NOT EXISTS relatorios (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            campanha TEXT, 
            carteira TEXT, 
            template TEXT,
            arquivo TEXT,
            cod_dev TEXT, 
            telefone TEXT, 
            status TEXT, 
            data TEXT
        );
        CREATE TABLE IF NOT EXISTS templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            carteiraId INTEGER,
            nome TEXT, 
            codigo TEXT, 
            texto TEXT,
            imagem TEXT
        );
        CREATE TABLE IF NOT EXISTS campanhas_agendadas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nomeCampanha TEXT,
            carteiraId TEXT,
            templateId TEXT,
            sessaoWhatsApp TEXT,
            validarNumeros TEXT,
            dataAgendamento TEXT,
            caminhoPlanilha TEXT,
            nomeArquivoOriginal TEXT,
            status TEXT
        );
        CREATE TABLE IF NOT EXISTS auditoria (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario TEXT,
            acao TEXT,
            detalhes TEXT,
            data TEXT
        );
    `);

    try { await db.exec(`ALTER TABLE usuarios ADD COLUMN permissoes TEXT;`); } catch(e) {}
    try { await db.exec(`ALTER TABLE relatorios ADD COLUMN template TEXT;`); } catch(e) {}
    try { await db.exec(`ALTER TABLE relatorios ADD COLUMN arquivo TEXT;`); } catch(e) {}
    try { await db.exec(`ALTER TABLE campanhas_agendadas ADD COLUMN nomeArquivoOriginal TEXT;`); } catch(e) {}

    const adminExistente = await db.get(`SELECT * FROM usuarios WHERE login = ?`, ['admin@admin.com']);
    if (!adminExistente) {
        const senhaHash = await bcrypt.hash('123456', 10);
        await db.run(
            `INSERT INTO usuarios (nome, login, senha, tipo, status, permissoes) VALUES (?, ?, ?, ?, ?, ?)`, 
            ['Administrador', 'admin@admin.com', senhaHash, 'Administrador', 'Ativo', JSON.stringify(['campanha', 'templates', 'carteiras', 'usuarios', 'relatorios', 'sessoes', 'auditoria'])]
        );
    }
    console.log('📂 Banco de dados SQLite estruturado com sucesso!');
}
iniciarBanco();

const sessoesWhatsAppMap = new Map();

function criarClienteWhatsApp(idSessao) {
    if (sessoesWhatsAppMap.has(idSessao)) {
        const sessaoAntiga = sessoesWhatsAppMap.get(idSessao);
        try { sessaoAntiga.client.destroy(); } catch(e){}
    }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: idSessao }),
        puppeteer: { 
            headless: 'new',
            executablePath: undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--deterministic-fetch',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        }
    });

    const dadosSessao = { client, numero: 'Aguardando QR Code...', status: 'Desconectado' };
    sessoesWhatsAppMap.set(idSessao, dadosSessao);

    client.on('qr', (qr) => {
        io.emit('qr', { sessao: idSessao, qr });
    });

    client.on('ready', async () => {
        try {
            const info = client.info;
            const numeroConectado = info && info.wid ? info.wid.user : 'Conectado';
            dadosSessao.numero = numeroConectado;
            dadosSessao.status = 'Conectado';
            io.emit('sessao_status', { sessao: idSessao, status: 'Conectado', numero: numeroConectado });
            console.log(`✅ WhatsApp conectado na sessão [${idSessao}] - Número: ${numeroConectado}`);
        } catch(e) {
            dadosSessao.status = 'Conectado';
            io.emit('sessao_status', { sessao: idSessao, status: 'Conectado', numero: 'Conectado' });
        }
    });

    client.on('disconnected', (reason) => {
        dadosSessao.numero = 'Desconectado';
        dadosSessao.status = 'Desconectado';
        io.emit('sessao_status', { sessao: idSessao, status: 'Desconectado', numero: 'Desconectado' });
        sessoesWhatsAppMap.delete(idSessao);
    });

    client.initialize();
    return client;
}

criarClienteWhatsApp('Principal');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function tempoAleatorio() { return Math.floor(Math.random() * (25000 - 10000 + 1)) + 10000; }

function obterDataLocal() {
    const agora = new Date();
    const horaBrasil = new Date(agora.getTime() - (3 * 60 * 60 * 1000));
    const ano = horaBrasil.getUTCFullYear();
    const mes = String(horaBrasil.getUTCMonth() + 1).padStart(2, '0');
    const dia = String(horaBrasil.getUTCDate()).padStart(2, '0');
    const horas = String(horaBrasil.getUTCHours()).padStart(2, '0');
    const minutos = String(horaBrasil.getUTCMinutes()).padStart(2, '0');
    const segundos = String(horaBrasil.getUTCSeconds()).padStart(2, '0');
    return `${ano}-${mes}-${dia} ${horas}:${minutos}:${segundos}`;
}

function normalizarTelefone(telBruto) {
    if (!telBruto) return '';
    let apenasNumeros = String(telBruto).replace(/\D/g, '');
    if (apenasNumeros.length === 10 || apenasNumeros.length === 11) apenasNumeros = '55' + apenasNumeros;
    if (apenasNumeros.startsWith('55') && apenasNumeros.length === 12) {
        const ddd = apenasNumeros.substring(2, 4);
        const numeroSemDdd = apenasNumeros.substring(4);
        if (numeroSemDdd.length === 8 && ['6', '7', '8', '9'].includes(numeroSemDdd[0])) {
            apenasNumeros = '55' + ddd + '9' + numeroSemDdd;
        }
    }
    return apenasNumeros;
}

let progressoCampanha = { ativo: false, pausado: false, nome: '', total: 0, atual: 0, enviados: 0, erros: 0, inicio: 0 };

app.get('/api/status-disparo', (req, res) => { res.json(progressoCampanha); });
app.post('/api/pausar-disparo', (req, res) => { progressoCampanha.pausado = true; res.json({ sucesso: true }); });
app.post('/api/retomar-disparo', (req, res) => { progressoCampanha.pausado = false; res.json({ sucesso: true }); });
app.post('/api/cancelar-disparo', (req, res) => { progressoCampanha.ativo = false; progressoCampanha.pausado = false; res.json({ sucesso: true }); });

app.get('/api/sessoes-whatsapp', (req, res) => {
    const lista = [];
    for (let [nome, dados] of sessoesWhatsAppMap.entries()) {
        lista.push({ nome, numero: dados.numero, status: dados.status });
    }
    res.json(lista);
});

app.post('/api/sessoes-whatsapp', (req, res) => {
    const { nomeSessao } = req.body;
    if (!nomeSessao) return res.status(400).json({ erro: 'Informe o nome da sessão.' });
    criarClienteWhatsApp(nomeSessao.trim());
    res.json({ sucesso: true });
});

// Rota de Reconexão Remota
app.post('/api/sessoes-whatsapp/reiniciar/:nome', (req, res) => {
    const nomeSessao = req.params.nome;
    criarClienteWhatsApp(nomeSessao);
    res.json({ sucesso: true, mensagem: `Reiniciando sessão ${nomeSessao}...` });
});

app.delete('/api/sessoes-whatsapp/:nome', async (req, res) => {
    const nomeSessao = req.params.nome;
    if (sessoesWhatsAppMap.has(nomeSessao)) {
        const cliente = sessoesWhatsAppMap.get(nomeSessao).client;
        try { await cliente.destroy(); } catch(e){}
        sessoesWhatsAppMap.delete(nomeSessao);
    }
    const caminhoAuth = path.join('.wwebjs_auth', `session-${nomeSessao}`);
    if (fs.existsSync(caminhoAuth)) {
        try { fs.rmSync(caminhoAuth, { recursive: true, force: true }); } catch(e){}
    }
    io.emit('sessao_removida', { sessao: nomeSessao });
    res.json({ sucesso: true });
});

app.post('/api/login', async (req, res) => {
    try {
        const { login, senha } = req.body;
        if (!login || !senha) return res.status(400).json({ erro: 'Informe o e-mail e a senha.' });

        const usuario = await db.get(`SELECT * FROM usuarios WHERE login = ? AND status = 'Ativo'`, [login.trim()]);
        if (!usuario || !usuario.senha) return res.status(401).json({ erro: 'Usuário não encontrado ou sem senha.' });

        const senhaCorreta = await bcrypt.compare(senha, usuario.senha);
        if (!senhaCorreta) return res.status(401).json({ erro: 'Senha incorreta.' });

        const { senha: _, ...dadosUsuario } = usuario;
        try {
            dadosUsuario.permissoes = JSON.parse(dadosUsuario.permissoes || '["campanha", "templates", "carteiras", "usuarios", "relatorios", "sessoes", "auditoria"]');
        } catch (e) {
            dadosUsuario.permissoes = ['campanha', 'templates', 'carteiras', 'usuarios', 'relatorios', 'sessoes', 'auditoria'];
        }

        res.json({ sucesso: true, usuario: dadosUsuario });
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

app.post('/api/testar-template', upload.single('imagem'), async (req, res) => {
    try {
        const { telefoneTeste, texto, sessaoWhatsApp } = req.body;
        if (!telefoneTeste || !texto) return res.status(400).json({ erro: 'Informe o telefone e o texto.' });

        const numeroNormalizado = normalizarTelefone(telefoneTeste);
        const sessaoObj = sessoesWhatsAppMap.get(sessaoWhatsApp || 'Principal');
        if (!sessaoObj || sessaoObj.status !== 'Conectado') return res.status(400).json({ erro: 'Sessão selecionada não está conectada.' });

        const clientUsado = sessaoObj.client;
        const contatoValido = await clientUsado.getNumberId(numeroNormalizado);
        const destino = contatoValido ? contatoValido._serialized : numeroNormalizado;

        const imagemPath = req.file ? req.file.path : null;
        if (imagemPath && fs.existsSync(imagemPath)) {
            const extensao = path.extname(imagemPath).toLowerCase() || '.png';
            const mimeType = extensao === '.png' ? 'image/png' : 'image/jpeg';
            const arquivoBase64 = fs.readFileSync(imagemPath, { encoding: 'base64' });
            const media = new MessageMedia(mimeType, arquivoBase64, 'teste' + extensao);
            await clientUsado.sendMessage(destino, media, { caption: texto });
            try { fs.unlinkSync(imagemPath); } catch(e){}
        } else {
            await clientUsado.sendMessage(destino, texto);
        }

        res.json({ sucesso: true, mensagem: 'Mensagem de teste disparada com sucesso!' });
    } catch (e) {
        res.status(500).json({ erro: 'Erro ao enviar teste: ' + e.message });
    }
});

async function executarDisparoReal(configCampanha) {
    const { nomeCampanha, carteiraId, templateId, validarNumeros, caminhoPlanilha, nomeArquivoOriginal } = configCampanha;
    
    let sessoesConectadas = [];
    for (let [nome, dados] of sessoesWhatsAppMap.entries()) {
        if (dados.status === 'Conectado') sessoesConectadas.push(nome);
    }
    if (sessoesConectadas.length === 0) sessoesConectadas = ['Principal'];
    
    let indiceSessaoRotativa = 0;

    const carteiraRow = await db.get(`SELECT * FROM carteiras WHERE id = ?`, [carteiraId]);
    const nomeCarteira = carteiraRow ? `${carteiraRow.nome} (Cod: ${carteiraRow.codigo})` : 'Geral';

    const templateRow = await db.get(`SELECT * FROM templates WHERE id = ?`, [templateId]);
    if (!templateRow) return;

    const nomeTemplate = templateRow.nome || 'Padrão';
    const nomeArquivo = nomeArquivoOriginal || 'planilha.csv';

    const linhasLidas = [];
    if (!fs.existsSync(caminhoPlanilha)) return;

    await new Promise((resolve) => {
        fs.createReadStream(caminhoPlanilha)
            .pipe(parse({ delimiter: ';', columns: true, trim: true }))
            .on('data', (linha) => { linhasLidas.push(linha); })
            .on('end', resolve);
    });

    if (linhasLidas.length === 0) return;

    progressoCampanha = {
        ativo: true,
        pausado: false,
        nome: nomeCampanha || 'Campanha',
        total: linhasLidas.length,
        atual: 0,
        enviados: 0,
        erros: 0,
        inicio: Date.now()
    };

    let contadorEnviosLote = 0;

    for (const linha of linhasLidas) {
        while (progressoCampanha.pausado) {
            if (!progressoCampanha.ativo) break;
            await delay(1000);
        }
        if (!progressoCampanha.ativo) break;

        progressoCampanha.atual++;
        
        if (contadorEnviosLote > 0 && contadorEnviosLote % 30 === 0) {
            progressoCampanha.nome = `${nomeCampanha} (Pausa de Segurança Anti-Spam - 3 min)`;
            await delay(180000);
            progressoCampanha.nome = nomeCampanha;
        }

        const nomeSessaoAtual = sessoesConectadas[indiceSessaoRotativa % sessoesConectadas.length];
        indiceSessaoRotativa++;
        const sessaoObj = sessoesWhatsAppMap.get(nomeSessaoAtual);
        const clientUsado = sessaoObj ? sessaoObj.client : null;

        if (!clientUsado) {
            progressoCampanha.erros++;
            continue;
        }

        let mensagemFinal = templateRow.texto;
        for (let i = 1; i <= 10; i++) {
            const regexVar = new RegExp(`{{var${i}}}`, 'ig');
            const regexUpper = new RegExp(`{{VARIAVEL${i}}}`, 'ig');
            const valorVariavel = linha[`var${i}`] || linha[`VARIAVEL${i}`] || '';
            mensagemFinal = mensagemFinal.replace(regexVar, valorVariavel).replace(regexUpper, valorVariavel);
        }
        mensagemFinal = mensagemFinal.replace(/{{COD_DEV}}/ig, linha.COD_DEV || '');

        const numeroLimpo = normalizarTelefone(linha.TELEFONE);
        const codDev = linha.COD_DEV || '';
        let statusEnvio = 'Erro';

        let tentativas = 0;
        let sucessoEnvio = false;

        while (tentativas < 3 && !sucessoEnvio && progressoCampanha.ativo) {
            try {
                const contatoValido = await clientUsado.getNumberId(numeroLimpo);
                if (validarNumeros === 'true' && !contatoValido) {
                    statusEnvio = 'Número Sem WhatsApp';
                    progressoCampanha.erros++;
                    break;
                } else if (contatoValido || validarNumeros !== 'true') {
                    const destino = contatoValido ? contatoValido._serialized : numeroLimpo;
                    if (templateRow.imagem && fs.existsSync(templateRow.imagem)) {
                        const extensao = path.extname(templateRow.imagem).toLowerCase() || '.png';
                        const mimeType = extensao === '.png' ? 'image/png' : 'image/jpeg';
                        const arquivoBase64 = fs.readFileSync(templateRow.imagem, { encoding: 'base64' });
                        const media = new MessageMedia(mimeType, arquivoBase64, 'foto' + extensao);
                        
                        await clientUsado.sendMessage(destino, media, { caption: mensagemFinal, sendMediaAsDocument: false });
                    } else {
                        await clientUsado.sendMessage(destino, mensagemFinal);
                    }
                    statusEnvio = 'Enviado/Entregue';
                    progressoCampanha.enviados++;
                    sucessoEnvio = true;
                    contadorEnviosLote++;
                } else {
                    statusEnvio = 'Número Inválido';
                    progressoCampanha.erros++;
                    break;
                }
            } catch (e) {
                tentativas++;
                if (tentativas >= 3) {
                    statusEnvio = 'Falha no Envio';
                    progressoCampanha.erros++;
                } else {
                    await delay(3000);
                }
            }
        }

        const dataHoraLocal = obterDataLocal();
        await db.run(
            `INSERT INTO relatorios (campanha, carteira, template, arquivo, cod_dev, telefone, status, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [nomeCampanha || 'Campanha', nomeCarteira, nomeTemplate, nomeArquivo, codDev, numeroLimpo, statusEnvio, dataHoraLocal]
        );

        await delay(tempoAleatorio());
    }

    progressoCampanha.ativo = false;
    progressoCampanha.pausado = false;
    try { fs.unlinkSync(caminhoPlanilha); } catch(e) {}
}

app.post('/api/disparar', upload.single('planilha'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Envie a planilha CSV' });
    if (progressoCampanha.ativo) return res.status(400).json({ erro: 'Já existe uma campanha ativa no momento.' });

    const { nomeCampanha, carteiraId, templateId, dataAgendamento, sessaoWhatsApp, validarNumeros } = req.body;
    const caminhoPlanilha = req.file.path;
    const nomeArquivoOriginal = req.file.originalname;

    if (dataAgendamento) {
        const tempoRestanteMs = new Date(dataAgendamento).getTime() - Date.now();
        if (tempoRestanteMs > 0) {
            await db.run(
                `INSERT INTO campanhas_agendadas (nomeCampanha, carteiraId, templateId, sessaoWhatsApp, validarNumeros, dataAgendamento, caminhoPlanilha, nomeArquivoOriginal, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [nomeCampanha, carteiraId, templateId, sessaoWhatsApp, validarNumeros, dataAgendamento, caminhoPlanilha, nomeArquivoOriginal, 'Agendada']
            );

            setTimeout(async () => {
                const agendada = await db.get(`SELECT * FROM campanhas_agendadas WHERE nomeCampanha = ? AND status = 'Agendada'`, [nomeCampanha]);
                if (agendada) {
                    await db.run(`UPDATE campanhas_agendadas SET status = 'Executada' WHERE id = ?`, [agendada.id]);
                    executarDisparoReal(agendada);
                }
            }, tempoRestanteMs);

            return res.json({ mensagem: `Campanha agendada com sucesso para ${dataAgendamento}!` });
        }
    }

    res.json({ mensagem: 'Campanha iniciada com distelhamento rotativo automático!' });
    executarDisparoReal({ nomeCampanha, carteiraId, templateId, sessaoWhatsApp, validarNumeros, caminhoPlanilha, nomeArquivoOriginal });
});

app.get('/api/agendadas', async (req, res) => {
    res.json(await db.all(`SELECT * FROM campanhas_agendadas WHERE status = 'Agendada' ORDER BY dataAgendamento ASC`));
});
app.post('/api/agendadas/reagendar/:id', async (req, res) => {
    const { novaData } = req.body;
    await db.run(`UPDATE campanhas_agendadas SET dataAgendamento = ? WHERE id = ?`, [novaData, req.params.id]);
    res.json({ sucesso: true });
});
app.delete('/api/agendadas/:id', async (req, res) => {
    const agendada = await db.get(`SELECT * FROM campanhas_agendadas WHERE id = ?`, [req.params.id]);
    if (agendada && agendada.caminhoPlanilha && fs.existsSync(agendada.caminhoPlanilha)) {
        try { fs.unlinkSync(agendada.caminhoPlanilha); } catch(e) {}
    }
    await db.run(`DELETE FROM campanhas_agendadas WHERE id = ?`, [req.params.id]);
    res.json({ sucesso: true });
});

app.get('/api/sintetico-campanhas', async (req, res) => {
    const dados = await db.all(`
        SELECT campanha, carteira, template, arquivo, COUNT(*) as total,
               SUM(CASE WHEN status = 'Enviado/Entregue' THEN 1 ELSE 0 END) as enviados,
               SUM(CASE WHEN status != 'Enviado/Entregue' THEN 1 ELSE 0 END) as erros,
               MAX(data) as ultima_data
        FROM relatorios 
        GROUP BY campanha, carteira 
        ORDER BY id DESC
    `);
    res.json(dados);
});

app.get('/api/templates', async (req, res) => { 
    try {
        const dados = await db.all(`SELECT templates.*, carteiras.nome as nomeCarteira FROM templates LEFT JOIN carteiras ON templates.carteiraId = carteiras.id`); 
        res.json(dados);
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/templates', (req, res) => {
    uploadImagem.single('imagem')(req, res, async (err) => {
        if (err) return res.status(500).json({ erro: 'Erro no upload: ' + err.message });
        try {
            const { carteiraId, nome, codigo, texto } = req.body;
            const imagemPath = req.file ? req.file.path : null;
            await db.run(`INSERT INTO templates (carteiraId, nome, codigo, texto, imagem) VALUES (?, ?, ?, ?, ?)`, [carteiraId || null, nome, codigo, texto, imagemPath]);
            res.json({ sucesso: true });
        } catch (e) { res.status(500).json({ erro: e.message }); }
    });
});

app.put('/api/templates/:id', (req, res) => {
    uploadImagem.single('imagem')(req, res, async (err) => {
        if (err) return res.status(500).json({ erro: 'Erro no upload: ' + err.message });
        try {
            const { carteiraId, nome, codigo, texto } = req.body;
            const templateAntigo = await db.get(`SELECT * FROM templates WHERE id = ?`, [req.params.id]);
            let imagemPath = templateAntigo ? templateAntigo.imagem : null;
            if (req.file) {
                if (imagemPath && fs.existsSync(imagemPath)) fs.unlinkSync(imagemPath);
                imagemPath = req.file.path;
            }
            await db.run(`UPDATE templates SET carteiraId = ?, nome = ?, codigo = ?, texto = ?, imagem = ? WHERE id = ?`, [carteiraId || null, nome, codigo, texto, imagemPath, req.params.id]);
            res.json({ sucesso: true });
        } catch (e) { res.status(500).json({ erro: e.message }); }
    });
});

app.delete('/api/templates/:id', async (req, res) => {
    try {
        const template = await db.get(`SELECT * FROM templates WHERE id = ?`, [req.params.id]);
        if (template && template.imagem && fs.existsSync(template.imagem)) fs.unlinkSync(template.imagem);
        await db.run(`DELETE FROM templates WHERE id = ?`, [req.params.id]);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/carteiras', async (req, res) => { res.json(await db.all(`SELECT * FROM carteiras`)); });
app.post('/api/carteiras', async (req, res) => {
    const { nome, codigo, status } = req.body;
    await db.run(`INSERT INTO carteiras (nome, codigo, status) VALUES (?, ?, ?)`, [nome, codigo, status]);
    res.json({ sucesso: true });
});
app.put('/api/carteiras/:id', async (req, res) => {
    const { nome, codigo, status } = req.body;
    await db.run(`UPDATE carteiras SET nome = ?, codigo = ?, status = ? WHERE id = ?`, [nome, codigo, status, req.params.id]);
    res.json({ sucesso: true });
});
app.delete('/api/carteiras/:id', async (req, res) => {
    await db.run(`DELETE FROM carteiras WHERE id = ?`, [req.params.id]);
    res.json({ sucesso: true });
});

app.get('/api/usuarios', async (req, res) => { 
    const usuarios = await db.all(`SELECT id, nome, login, tipo, status, permissoes FROM usuarios`);
    res.json(usuarios.map(u => ({ ...u, permissoes: JSON.parse(u.permissoes || '["campanha", "templates", "carteiras", "usuarios", "relatorios", "sessoes", "auditoria"]') }))); 
});

app.post('/api/usuarios', async (req, res) => {
    const { nome, login, senha, tipo, status, permissoes } = req.body;
    if (!senha) return res.status(400).json({ erro: 'A senha é obrigatória.' });
    const senhaHash = await bcrypt.hash(senha, 10);
    const permissoesJson = JSON.stringify(permissoes || []);
    await db.run(`INSERT INTO usuarios (nome, login, senha, tipo, status, permissoes) VALUES (?, ?, ?, ?, ?, ?)`, [nome, login, senhaHash, tipo, status, permissoesJson]);
    res.json({ sucesso: true });
});

app.put('/api/usuarios/:id', async (req, res) => {
    const { nome, login, senha, tipo, status, permissoes } = req.body;
    const permissoesJson = JSON.stringify(permissoes || []);
    if (senha && senha.trim() !== '') {
        const senhaHash = await bcrypt.hash(senha, 10);
        await db.run(`UPDATE usuarios SET nome = ?, login = ?, senha = ?, tipo = ?, status = ?, permissoes = ? WHERE id = ?`, [nome, login, senhaHash, tipo, status, permissoesJson, req.params.id]);
    } else {
        await db.run(`UPDATE usuarios SET nome = ?, login = ?, tipo = ?, status = ?, permissoes = ? WHERE id = ?`, [nome, login, tipo, status, permissoesJson, req.params.id]);
    }
    res.json({ sucesso: true });
});

app.delete('/api/usuarios/:id', async (req, res) => {
    await db.run(`DELETE FROM usuarios WHERE id = ?`, [req.params.id]);
    res.json({ sucesso: true });
});

app.get('/api/relatorios', async (req, res) => { res.json(await db.all(`SELECT * FROM relatorios ORDER BY id DESC LIMIT 1000`)); });

server.listen(3000, () => { console.log('🚀 Plataforma rodando em: http://localhost:3000'); });