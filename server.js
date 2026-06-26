require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'comparador_cupons';
console.log("Link do Banco carregado:", MONGODB_URI);
const mongoClient = new MongoClient(MONGODB_URI);

async function getMongoDb() {
    if (!MONGODB_URI) {
        throw new Error('MONGODB_URI não está definida. Defina a variável de ambiente antes de usar MongoDB.');
    }
    if (!mongoClient.topology || !mongoClient.topology.isConnected()) {
        await mongoClient.connect();
    }
    return mongoClient.db(MONGODB_DB);
}

async function testarConexaoMongo() {
    const db = await getMongoDb();
    await db.admin().ping();
    return { ok: true, mensagem: 'Conexão MongoDB OK' };
}

async function salvarCupomMongo(cupom) {
    const db = await getMongoDb();
    const collection = db.collection('cupons');
    const resultado = await collection.insertOne({
        ...cupom,
        criadoEm: new Date(),
    });
    return resultado.insertedId;
}

const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Servir arquivos estáticos
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Arquivo não encontrado');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else if (req.url === '/app.js') {
        fs.readFile(path.join(__dirname, 'app.js'), (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Arquivo não encontrado');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end(data);
        });
    } else if (req.url === '/style.css') {
        fs.readFile(path.join(__dirname, 'style.css'), (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Arquivo não encontrado');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/css' });
            res.end(data);
        });
    } else if (req.url === '/teste-nfce') {
        // Endpoint de teste com HTML de exemplo de uma NFC-e
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
    } else if (req.url.startsWith('/debug-html?url=')) {
        // Endpoint para debugar HTML - salva em arquivo
        const urlParam = decodeURIComponent(req.url.split('url=')[1]);
        const fetchUrl = urlParam.startsWith('http') ? urlParam : 'https://' + urlParam;
        const protocol = fetchUrl.startsWith('https') ? https : http;
        
        protocol.get(fetchUrl, (externalRes) => {
            let data = '';
            
            externalRes.on('data', (chunk) => {
                data += chunk;
            });
            
            externalRes.on('end', () => {
                // Salva o HTML em arquivo para debug
                fs.writeFileSync(path.join(__dirname, 'debug-nfce.html'), data, 'utf-8');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    message: 'HTML salvo em debug-nfce.html',
                    size: data.length
                }));
            });
        }).on('error', (err) => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
        });
    } else if (req.url.startsWith('/fetch-html?url=')) {
        // Proxy para buscar HTML de URLs externas
        const urlParam = decodeURIComponent(req.url.split('url=')[1]);
        
        const fetchUrl = urlParam.startsWith('http') ? urlParam : 'https://' + urlParam;
        
        // Detecta o protocolo correto
        const protocol = fetchUrl.startsWith('https') ? https : http;
        
        protocol.get(fetchUrl, (externalRes) => {
            let data = '';
            
            externalRes.on('data', (chunk) => {
                data += chunk;
            });
            
            externalRes.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(data);
            });
        }).on('error', (err) => {
            console.error('Erro ao buscar URL:', err.message);
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
        });
    } else if (req.url === '/teste-mongo' && req.method === 'GET') {
        testarConexaoMongo()
            .then(result => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            })
            .catch(err => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, mensagem: err.message }));
            });
    } else if (req.url === '/salvar-cupom' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const cupom = JSON.parse(body);
                const insertedId = await salvarCupomMongo(cupom);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, insertedId }));
            } catch (err) {
                console.error('Erro ao salvar cupom:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, mensagem: err.message }));
            }
        });
    } else {
        res.writeHead(404);
        res.end('Não encontrado');
    }
});

const PORT = 8080;
server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`📱 Acesse a aplicação em http://localhost:${PORT}`);
    console.log(`🧪 Para testar com HTML de exemplo, use: http://localhost:${PORT}/teste-nfce`);
    console.log(`\nPressione Ctrl+C para parar o servidor`);
});
