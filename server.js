// CONFIGURAÇÕES INICIAIS
require('dotenv').config();
require('dns').setServers(['8.8.8.8', '8.8.4.4']);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { MongoClient } = require('mongodb');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'comparador_cupons';

console.log('Link do Banco carregado:', MONGODB_URI);

// CONEXÃO COM MONGO
let mongoClient = null;
let mongoConnected = false;

async function getMongoDb() {
    if (!mongoClient) {
        mongoClient = new MongoClient(MONGODB_URI, {
            tls: true,
            family: 4
        });
    }

    if (!mongoConnected) {
        await mongoClient.connect();
        mongoConnected = true;
        console.log('MongoDB conectado com sucesso.');
    }

    return mongoClient.db(MONGODB_DB);
}

// FUNÇÃO PARA SERVIR ARQUIVOS ESTÁTICOS (HTML, CSS, JS)
function serveStaticFile(res, filePath, contentType = 'text/html') {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            console.error("ERRO: O servidor tentou abrir este caminho e não achou:", filePath);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, mensagem: 'Erro ao carregar arquivo.' }));
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

// FUNÇÃO PARA ENVIAR JSON
function sendJson(res, status, payload) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(payload));
}

// ROTAS DA API AUXILIARES
async function handleHistorico(req, res) {
    const db = await getMongoDb();
    const compras = await db.collection('compras').find().toArray();
    sendJson(res, 200, { ok: true, compras });
}

async function handleProdutos(req, res) {
    const db = await getMongoDb();
    const produtos = await db.collection('produtos').find().toArray();
    sendJson(res, 200, { ok: true, produtos });
}

// ROTEADOR PRINCIPAL
async function requestHandler(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // CORS
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        return res.end();
    }

    // SERVIR FRONTEND
    if (pathname === '/' && req.method === 'GET') {
        const indexPath = path.join(__dirname, 'public', 'index.html');
        return serveStaticFile(res, indexPath, 'text/html');
    }
    
    // ROTA PARA PROCESSAR O CUPOM FISCAL
    if (pathname === '/processar' && req.method === 'POST') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const dados = JSON.parse(body || '{}');
                if (!dados.url) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ ok: false, mensagem: 'URL não fornecida.' }));
                }

                console.log("Buscando cupom fiscal na SEFAZ:", dados.url);

                // 1. Faz o download do HTML real da nota fiscal
                https.get(dados.url, (respostaSefaz) => {
                    let htmlChunks = [];

                    respostaSefaz.on('data', chunk => htmlChunks.push(chunk));

                    respostaSefaz.on('end', async () => {
                        try {
                            const htmlCompleto = Buffer.concat(htmlChunks).toString('utf-8');
                            
                            // 2. Carrega a página no Cheerio para raspagem
                            const $ = cheerio.load(htmlCompleto);
                            
                            // Coleta o nome do estabelecimento emitente
                            const establishmentName = $('.txtEmi').first().text().trim() || 'Estabelecimento Desconhecido';
                            
                            let produtosCapturados = [];

                            // Varre a tabela de resultados clássica das NFC-e
                            $('table[id^="tabResult"] tr, .mDados').each((index, element) => {
                                const nomeProduto = $(element).find('.txtTit').text().trim();
                                const quantidade = parseFloat($(element).find('.Rqtd').text().replace('Qtde.:', '').replace(',', '.').trim()) || 1;
                                const valorUnitario = parseFloat($(element).find('.RvalUnit').text().replace('Vl. Unit.:', '').replace(',', '.').trim()) || 0;
                                
                                if (nomeProduto) {
                                    produtosCapturados.push({
                                        nome: nomeProduto,
                                        quantidade: quantidade, // CORRIGIDO: Atribuição limpa sem variáveis órfãs
                                        preco_unitario: valorUnitario,
                                        total_item: quantidade * valorUnitario,
                                        data_cadastro: new Date()
                                    });
                                }
                            });

                            // Fallback caso a SEFAZ use tabelas genéricas sem classes chamativas
                            if (produtosCapturados.length === 0) {
                                $('tr').each((i, el) => {
                                    const cols = $(el).find('td');
                                    if (cols.length >= 3) {
                                        const nome = $(cols[0]).text().trim();
                                        if (nome && !nome.includes('Total') && !nome.includes('Item')) {
                                            produtosCapturados.push({
                                                nome: nome,
                                                quantidade: 1,
                                                preco_unitario: 0,
                                                total_item: 0,
                                                data_cadastro: new Date()
                                            });
                                        }
                                    }
                                });
                            }

                            // 3. Conecta e Salva os registros estruturados no MongoDB Atlas
                            const db = await getMongoDb();
                            
                            // Cria a estrutura exata do objeto de compra
                            const estruturaCompra = {
                                estabelecimento: establishmentName,
                                url_nota: dados.url,
                                data_compra: new Date(),
                                quantidade_itens: produtosCapturados.length,
                                produtos: produtosCapturados
                            };

                            // Salva a transação completa no histórico de compras
                            await db.collection('compras').insertOne(estruturaCompra);

                            // Atualiza ou insere na coleção global de produtos cadastrados para comparação de preços
                            if (produtosCapturados.length > 0) {
                                for (let prod of produtosCapturados) {
                                    await db.collection('produtos').updateOne(
                                        { nome: prod.nome },
                                        { 
                                            $set: { preco_ultimo: prod.preco_unitario, estabelecimento_ultimo: establishmentName, atualizado_em: new Date() },
                                            $setOnInsert: { criado_em: new Date() }
                                        },
                                        { upsert: true }
                                    );
                                }
                            }

                            console.log(`Sucesso: ${produtosCapturados.length} produtos adicionados ao MongoDB Atlas.`);

                            // 4. Retorna a resposta com a chave "compra" exigida pelo index.html
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            return res.end(JSON.stringify({ 
                                ok: true, 
                                mensagem: 'Cupom processado e salvo com sucesso!',
                                compra: estruturaCompra
                            }));

                        } catch (errInternal) {
                            console.error("Erro no parser do HTML:", errInternal);
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            return res.end(JSON.stringify({ ok: false, mensagem: 'Erro interno ao processar dados da nota.' }));
                        }
                    });

                }).on('error', (errNetwork) => {
                    console.error("Erro na comunicação com a SEFAZ:", errNetwork.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ ok: false, mensagem: 'Não foi possível baixar os dados da SEFAZ.' }));
                });

            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ok: false, mensagem: 'Falha crítica na leitura dos parâmetros.' }));
            }
        });
        return; 
    }

    // ROTA ADICIONAL: CONSULTA DE PRODUTOS DIRETO NO BANCO DE DADOS
    if (pathname === '/consultar-preco' && req.method === 'GET') {
        try {
            const termoBusca = parsedUrl.searchParams.get('nome') || '';
            if (!termoBusca) {
                return sendJson(res, 400, { ok: false, mensagem: 'Digite um termo para pesquisar.' });
            }

            const db = await getMongoDb();
            const resultados = await db.collection('produtos').find({
                nome: { $regex: termoBusca, $options: 'i' }
            }).toArray();

            if (resultados.length === 0) {
                return sendJson(res, 200, { ok: true, mensagem: 'Nenhum produto encontrado.', qtdRegistros: 0, produtos: [] });
            }

            const precos = resultados.map(p => p.preco_ultimo).filter(p => p > 0);
            const menorPreco = precos.length > 0 ? Math.min(...precos) : 0;
            const ultimoPreco = resultados[resultados.length - 1].preco_ultimo || 0;

            return sendJson(res, 200, {
                ok: true,
                ultimoPreco: ultimoPreco,
                menorPreco: menorPreco,
                qtdRegistros: resultados.length,
                produtos: resultados
            });
        } catch (error) {
            console.error("Erro na rota de consulta:", error);
            return sendJson(res, 500, { ok: false, mensagem: 'Erro interno na busca.' });
        }
    }

    // SERVIR ARQUIVOS ESTÁTICOS (CSS, JS, IMAGENS)
    if (pathname.startsWith('/public/')) {
        const filePath = path.join(__dirname, pathname);
        const ext = path.extname(filePath).toLowerCase();

        const types = {
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.svg': 'image/svg+xml'
        };

        const contentType = types[ext] || 'application/octet-stream';
        return serveStaticFile(res, filePath, contentType);
    }

    // ROTAS DA API ANTIGAS
    if (pathname === '/historico' && req.method === 'GET') return handleHistorico(req, res);
    if (pathname === '/produtos' && req.method === 'GET') return handleProdutos(req, res);

    // ROTA NÃO ENCONTRADA
    sendJson(res, 404, { ok: false, message: 'Rota não encontrada' });
}

// INICIALIZAÇÃO DO SERVIDOR
const server = http.createServer(requestHandler);

server.listen(PORT, async () => {
    console.log(`Servidor rodando com sucesso na porta ${PORT}`);

    try {
        const db = await getMongoDb();
        await db.command({ ping: 1 });
        console.log('Conexão inicial com o MongoDB estabelecida com sucesso.');
    } catch (err) {
        console.error('Erro ao conectar no banco:', err.message);
    }
});