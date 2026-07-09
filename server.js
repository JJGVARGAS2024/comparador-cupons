// FORÇAR DNS DO GOOGLE GLOBALMENTE PARA EVITAR ECONNREFUSED DA OPERADORA
require('dns').setServers(['8.8.8.8', '8.8.4.4']);
require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { MongoClient, ObjectId } = require('mongodb');
const cheerio = require('cheerio');

// Inicializa MongoClient de forma segura.
let mongoClient = null;
let mongoConnected = false;

function initMongoClient() {
    if (!MONGODB_URI) return;
    if (!mongoClient) {
        mongoClient = new MongoClient(MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            tls: true,
            tlsAllowInvalidCertificates: true,
        });
    }
}

const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'comparador_cupons';
console.log('Link do Banco carregado:', MONGODB_URI);
// Não coloque a URI do MongoDB diretamente no código.
// Defina a variável `MONGODB_URI` no arquivo .env (ex: MONGODB_URI=mongodb+srv://user:senha@...)

async function getMongoDb() {
    if (!MONGODB_URI) {
        throw new Error('MONGODB_URI não está definida. Defina a variável de ambiente antes de usar MongoDB.');
    }

    initMongoClient();
    if (!mongoConnected) {
        try {
            await mongoClient.connect();
            mongoConnected = true;
            return mongoClient.db(MONGODB_DB);
        } catch (err) {
            console.warn('Falha ao conectar usando SRV:', err && err.message);

            const fallback = process.env.MONGODB_URI_FALLBACK || process.env.MONGODB_URI_NON_SRV;
            if (fallback && fallback !== MONGODB_URI) {
                console.log('Tentando reconectar usando MONGODB_URI_FALLBACK...');
                
                // CORREÇÃO: Adicionado 'family: 4' para forçar o IPv4 também no plano B
                mongoClient = new MongoClient(fallback, {
                    tls: true,
                    tlsAllowInvalidCertificates: true,
                    family: 4
                });
                
                await mongoClient.connect();
                mongoConnected = true;
                console.log('Conectado usando fallback.');
                return mongoClient.db(MONGODB_DB);
            }

            // rethrow original error if no fallback configured
            throw err;
        }
    }

    return mongoClient.db(MONGODB_DB);
}

async function testarConexaoMongo() {
    const db = await getMongoDb();
    await db.command({ ping: 1 });
    return { ok: true, mensagem: 'Conexão com MongoDB estabelecida com sucesso.' };
}

function normalizeText(text) {
    if (!text) return '';
    return text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function parseCurrency(value) {
    if (!value) return 0;
    const cleaned = String(value)
        .replace(/\./g, '')
        .replace(/,/g, '.')
        .replace(/[^0-9.\-]/g, '')
        .trim();
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
}

function parseDateText(text) {
    if (!text) return null;
    const dateRegex = /(?:(\d{2})\/(\d{2})\/(\d{4}))(?:\s*(\d{2}):(\d{2})(?::(\d{2}))?)?/;
    const match = text.match(dateRegex);
    if (!match) return null;
    const [, day, month, year, hour = '00', minute = '00', second = '00'] = match;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

function parseNfceHtml(html) {
    const $ = cheerio.load(html, { decodeEntities: true });
    
    const dados = {
        nome: {
            razaoSocial: '',
            cnpj: '',
            numeroNfce: '',
            serie: ''
        },
        dataCompra: null,
        valorTotal: 0,
        itens: []
    };

    const text = $('body').text();
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);

    const cnpjMatch = text.match(/(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})/);
    if (cnpjMatch) {
        let cnpj = cnpjMatch[1];
        if (cnpj.length === 14) {
            cnpj = cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
        }
        dados.nome.cnpj = cnpj;
    }

    const chaveMatch = text.match(/\b(\d{44})\b/);
    if (chaveMatch) {
        const chave = chaveMatch[1];
        dados.nome.serie = String(parseInt(chave.substring(22, 25), 10) || '').padStart(3, '0');
        dados.nome.numeroNfce = String(parseInt(chave.substring(25, 34), 10) || '').padStart(9, '0');
    }

    const data = parseDateText(text);
    if (data) {
        dados.dataCompra = data;
    }

    const totalMatch = text.match(/(?:valor total|total da nota|total geral|total)\s*[:\-]?\s*R\$\s*([\d\.,]+)/i);
    if (totalMatch) {
        dados.valorTotal = parseCurrency(totalMatch[1]);
    } else {
        const matches = [...text.matchAll(/R\$\s*([\d\.,]+)/g)];
        if (matches.length > 0) {
            dados.valorTotal = parseCurrency(matches[matches.length - 1][1]);
        }
    }

    const candidateName = $('h1, h2, h3, h4, strong').toArray().map(elem => $(elem).text().trim()).find(txt => txt && txt.length > 5 && !/nota fiscal|nf[ce]/i.test(txt));
    if (candidateName) {
        dados.nome.razaoSocial = candidateName;
    } else {
        const firstLine = lines.find(line => line.length > 5 && !/nota fiscal|nf[ce]/i.test(line));
        dados.nome.razaoSocial = firstLine || 'ESTABELECIMENTO DESCONHECIDO';
    }

    if (!dados.nome.numeroNfce) {
        const numeroMatch = text.match(/(?:nf[ce]|nota fiscal)\D*(\d{3,9})/i);
        if (numeroMatch) {
            dados.nome.numeroNfce = numeroMatch[1];
        }
    }

    const itemRows = [];
    $('table').each((_, table) => {
        $(table)
            .find('tr')
            .each((rowIndex, row) => {
                const cells = $(row).find('th, td').toArray();
                if (cells.length < 2) return;
                const rowText = $(row).text().trim().toLowerCase();
                const isHeader = /descri[cç][aã]o|quantidade|qtd|valor|unidade|total/.test(rowText) && /descri[cç][aã]o|produto/.test(rowText);
                if (isHeader) return;

                const columns = cells.map(cell => $(cell).text().trim());
                const description = columns[0] || '';
                const quantity = parseCurrency(columns[1]) || 1;
                let valorUnitario = 0;
                let total = 0;

                if (columns.length >= 4) {
                    valorUnitario = parseCurrency(columns[2]);
                    total = parseCurrency(columns[3]);
                } else if (columns.length === 3) {
                    valorUnitario = parseCurrency(columns[1]);
                    total = parseCurrency(columns[2]);
                } else {
                    for (let i = 1; i < columns.length; i += 1) {
                        const candidate = parseCurrency(columns[i]);
                        if (candidate > 0 && valorUnitario === 0) {
                            valorUnitario = candidate;
                        } else if (candidate > 0 && total === 0) {
                            total = candidate;
                        }
                    }
                }

                if (!total && quantity && valorUnitario) {
                    total = quantity * valorUnitario;
                }

                if (description && quantity > 0 && (valorUnitario > 0 || total > 0)) {
                    itemRows.push({ descricao: description, quantidade: quantity, valorUnitario, total });
                }
            });
    });

    if (itemRows.length > 0) {
        dados.itens = itemRows;
    } else {
        for (const line of lines) {
            const match = line.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s+R\$\s*([\d\.,]+)/i);
            if (match) {
                const descricao = match[1].trim();
                const quantidade = parseCurrency(match[2]);
                const valorUnitario = parseCurrency(match[3]);
                const total = quantidade * valorUnitario || valorUnitario;
                if (descricao && quantidade > 0 && valorUnitario > 0) {
                    dados.itens.push({ descricao, quantidade, valorUnitario, total });
                }
            }
        }
    }

    if (!dados.valorTotal && dados.itens.length > 0) {
        dados.valorTotal = dados.itens.reduce((sum, item) => sum + item.total, 0);
    }

    return dados;
}

// CORREÇÃO DOS AGENTES TLS: Forçando suporte legado exigido pelos servidores SEFAZ antigos
const tlsAgent = new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1',
    ciphers: 'DEFAULT:@SECLEVEL=1:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256',
    secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
});

const tlsFallbackAgent = new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1',
    ciphers: 'HIGH:!aNULL:!eNULL'
});

function fetchHtmlUrl(url, triedFallback = false) {
    return new Promise((resolve, reject) => {
        try {
            const targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
            const protocol = targetUrl.protocol === 'https:' ? https : http;
            
            // CORREÇÃO DOS HEADERS: Fingindo perfeitamente ser um navegador Google Chrome real
            const options = {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            };

            if (targetUrl.protocol === 'https:') {
                options.agent = triedFallback ? tlsFallbackAgent : tlsAgent;
            }

            const req = protocol.get(targetUrl, options, (externalRes) => {
                if (externalRes.statusCode >= 300 && externalRes.statusCode < 400 && externalRes.headers.location) {
                    resolve(fetchHtmlUrl(externalRes.headers.location, triedFallback));
                    return;
                }

                if (externalRes.statusCode !== 200) {
                    reject(new Error(`Falha ao buscar HTML. Status: ${externalRes.statusCode}`));
                    return;
                }

                let data = '';
                externalRes.on('data', (chunk) => { data += chunk; });
                externalRes.on('end', () => resolve(data));
            });

            req.on('error', (err) => {
                if (!triedFallback && targetUrl.protocol === 'https:') {
                    console.warn('fetchHtmlUrl: erro TLS, tentando o fallback...', err && err.code);
                    resolve(fetchHtmlUrl(url, true));
                    return;
                }
                reject(err);
            });
            
            req.end();
        } catch (err) {
            reject(err);
        }
    });
}

async function findOrCreateProduct(db, descricao) {
    const produtos = db.collection('produtos');
    const descricaoNorm = normalizeText(descricao);
    const produtoExistente = await produtos.findOne({ descricaoNorm });
    if (produtoExistente) return produtoExistente;

    const resultado = await produtos.insertOne({
        descricao: descricao.trim(),
        descricaoNorm,
        criadoEm: new Date(),
    });

    return { _id: resultado.insertedId, descricao: descricao.trim(), descricaoNorm };
}

async function salvarCompraMongo(compra) {
    const db = await getMongoDb();
    const compras = db.collection('compras');
    const itensComProduto = [];

    for (const item of compra.itens) {
        const produto = await findOrCreateProduct(db, item.descricao);
        itensComProduto.push({
            produtoId: produto._id,
            descricao: item.descricao.trim(),
            quantidade: item.quantidade,
            valorUnitario: item.valorUnitario,
            total: item.total,
        });
    }

    // Mantendo a padronização e garantindo o uso correto do campo 'nome' para o estabelecimento
    const compraDoc = {
        nome: compra.nome || {},
        dataCompra: compra.dataCompra ? new Date(compra.dataCompra) : new Date(),
        valorTotal: compra.valorTotal,
        itens: itensComProduto,
        criadoEm: new Date(),
    };

    const resultado = await compras.insertOne(compraDoc);
    compraDoc._id = resultado.insertedId;
    return compraDoc;
}

function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body || '{}'));
            } catch (err) {
                reject(new Error('JSON inválido no corpo da requisição.'));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}

async function handleProcessCupom(req, res) {
    try {
        const body = await parseRequestBody(req);
        const url = body.url;
        const html = body.html ? body.html : await fetchHtmlUrl(url);
        const dados = parseNfceHtml(html);
        sendJson(res, 200, { ok: true, compra: dados });
    } catch (err) {
        console.error('Erro no processamento do cupom:', err);
        sendJson(res, 500, { ok: false, mensagem: err.message });
    }
}

async function handleSalvarCupom(req, res) {
    try {
        const cupom = await parseRequestBody(req);
        const itens = Array.isArray(cupom.itens) ? cupom.itens : [];

        if (!cupom || !itens.length) {
            sendJson(res, 400, { ok: false, mensagem: 'Cupom inválido. Nenhum item encontrado.' });
            return;
        }

        const compraParaSalvar = {
            nome: cupom.nome || {
                razaoSocial: cupom.supermercado?.razaoSocial || '',
                cnpj: cupom.supermercado?.cnpj || '',
            },
            dataCompra: cupom.dataCompra || null,
            valorTotal: cupom.valorTotal || itens.reduce((sum, item) => sum + (Number(item.total) || 0), 0),
            itens: itens,
        };

        const compraSalva = await salvarCompraMongo(compraParaSalvar);
        sendJson(res, 200, { ok: true, compra: compraSalva });
    } catch (err) {
        console.error('Erro ao salvar cupom:', err);
        sendJson(res, 500, { ok: false, mensagem: err.message });
    }
}

async function handleHistorico(req, res) {
    try {
        const db = await getMongoDb();
        const compras = await db.collection('compras')
            .find()
            .sort({ dataCompra: -1, criadoEm: -1 })
            .limit(50)
            .toArray();
        sendJson(res, 200, { ok: true, compras });
    } catch (err) {
        console.error('Erro ao carregar histórico:', err);
        sendJson(res, 500, { ok: false, mensagem: err.message });
    }
}

async function handleProdutos(req, res) {
    try {
        const reqUrl = new URL(req.url, `http://${req.headers.host}`);
        const busca = reqUrl.searchParams.get('search') || '';
        const db = await getMongoDb();
        const produtosCol = db.collection('produtos');
        const comprasCol = db.collection('compras');

        const filtro = busca
            ? { descricaoNorm: { $regex: normalizeText(busca), $options: 'i' } }
            : {};
        const produtos = await produtosCol.find(filtro).limit(20).toArray();

        const resultados = [];
        for (const produto of produtos) {
            const compras = await comprasCol
                .find({ 'itens.produtoId': produto._id })
                .sort({ dataCompra: -1 })
                .toArray();

            const entradas = [];
            let menorPreco = Infinity;
            let ultimoPreco = 0;

            for (const compra of compras) {
                const item = compra.itens.find(i => i.produtoId?.toString() === produto._id.toString());
                if (!item) continue;
                entradas.push({
                    compraId: compra._id,
                    dataCompra: compra.dataCompra,
                    nome: compra.nome || {},
                    quantidade: item.quantidade,
                    valorUnitario: item.valorUnitario,
                    total: item.total,
                });
                if (item.valorUnitario > 0) {
                    menorPreco = Math.min(menorPreco, item.valorUnitario);
                    if (!ultimoPreco) {
                        ultimoPreco = item.valorUnitario;
                    }
                }
            }

            if (entradas.length > 0) {
                ultimoPreco = entradas[0].valorUnitario;
            }

            resultados.push({
                produto,
                ultimoPreco: ultimoPreco || 0,
                menorPreco: Number.isFinite(menorPreco) ? menorPreco : 0,
                historico: entradas,
            });
        }

        sendJson(res, 200, { ok: true, resultados });
    } catch (err) {
        console.error('Erro na consulta de produtos:', err);
        sendJson(res, 500, { ok: false, mensagem: err.message });
    }
}

function handleStaticFile(req, res, filePath, contentType) {
    fs.readFile(path.join(__dirname, filePath), (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Arquivo não encontrado');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    if (pathname === '/' || pathname === '/index.html') {
        handleStaticFile(req, res, 'index.html', 'text/html; charset=utf-8');
    } else if (pathname === '/app.js') {
        handleStaticFile(req, res, 'app.js', 'application/javascript');
    } else if (pathname === '/style.css') {
        handleStaticFile(req, res, 'style.css', 'text/css');
    } else if (pathname === '/teste-nfce') {
        const htmlTeste = `<!DOCTYPE html>
<html>
<head><title>NFC-e Teste</title></head>
<body>
    <h1>MAC SUPERMERCADO LTDA LJ0005</h1>
    <p>CNPJ: 20.633.061/0005-27</p>
    <p>Chave de Acesso: 35201612345678901234567890123456789012345678</p>
    
    <table border="1">
        <tr>
            <th>Descrição do Produto</th>
            <th>Quantidade</th>
            <th>Valor Unitário</th>
            <th>Valor Total</th>
        </tr>
        <tr>
            <td>REFRI COCA ZERO 200ML</td>
            <td>2</td>
            <td>R$ 1,99</td>
            <td>R$ 3,98</td>
        </tr>
        <tr>
            <td>REFRI COCA COLA ZE 600ML</td>
            <td>1</td>
            <td>R$ 5,69</td>
            <td>R$ 5,69</td>
        </tr>
        <tr>
            <td>LEITE INTEGRAL 1L</td>
            <td>3</td>
            <td>R$ 3,50</td>
            <td>R$ 10,50</td>
        </tr>
        <tr>
            <td>PÃO DE FORMA</td>
            <td>1</td>
            <td>R$ 4,99</td>
            <td>R$ 4,99</td>
        </tr>
    </table>
    
    <p>CPF Consumidor: 536.989.166-49</p>
    <p>Data: 23/06/2026 14:30:45</p>
</body>
</html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlTeste);
    } else if (pathname === '/debug-html') {
        const urlParam = parsedUrl.searchParams.get('url');
        if (!urlParam) {
            sendJson(res, 400, { ok: false, message: 'URL não fornecida.' });
            return;
        }
        fetchHtmlUrl(urlParam)
            .then((html) => {
                fs.writeFileSync(path.join(__dirname, 'debug-nfce.html'), html, 'utf-8');
                sendJson(res, 200, { ok: true, message: 'HTML salvo em debug-nfce.html', size: html.length });
            })
            .catch((err) => {
                console.error('Erro ao debugar HTML:', err);
                sendJson(res, 500, { ok: false, mensagem: err.message });
            });
    } else if (pathname === '/fetch-html' && req.method === 'GET') {
        const urlParam = parsedUrl.searchParams.get('url');
        if (!urlParam) {
            sendJson(res, 400, { ok: false, mensagem: 'URL não fornecida.' });
            return;
        }
        fetchHtmlUrl(urlParam)
            .then((html) => {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(html);
            })
            .catch((err) => {
                console.error('Erro ao buscar HTML via proxy:', err && err.stack ? err.stack : err);
                sendJson(res, 500, { ok: false, mensagem: err.message, stack: err.stack });
            });
    } else if (pathname === '/teste-mongo' && req.method === 'GET') {
        testarConexaoMongo()
            .then(result => sendJson(res, 200, result))
            .catch(err => sendJson(res, 500, { ok: false, mensagem: err.message }));
    } else if (pathname === '/process-cupom' && req.method === 'POST') {
        handleProcessCupom(req, res);
    } else if (pathname === '/salvar-cupom' && req.method === 'POST') {
        handleSalvarCupom(req, res);
    } else if (pathname === '/historico' && req.method === 'GET') {
        handleHistorico(req, res);
    } else if (pathname === '/produtos' && req.method === 'GET') {
        handleProdutos(req, res);
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Não encontrado');
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`📱 Acesse a aplicação em http://localhost:${PORT}`);
    console.log(`🧪 Para testar com HTML de exemplo, use: http://localhost:${PORT}/teste-nfce`);
    console.log('\nPressione Ctrl+C para parar o servidor');
});