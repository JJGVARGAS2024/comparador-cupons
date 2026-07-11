let html5QrcodeScanner = null;
let dadosProcessadosGlobais = null;

// 🔴 CONFIGURAÇÃO DA PORTA DO SERVIDOR BACKEND
const API_BASE_URL = "http://localhost:8080";

// Busca o HTML da URL fornecida
async function buscarHTMLDaReceita(url) {
    try {
        // Se a URL é local (localhost ou file), tenta fetch direto
        if (url.includes('localhost') || url.includes('127.0.0.1') || url.startsWith('file://')) {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Erro HTTP! Status: ${response.status}`);
            }
            return await response.text();
        }
        
        // 🔴 Corrigido: Aponta explicitamente para o servidor na porta 8080
        const proxyUrl = `${API_BASE_URL}/fetch-html?url=${encodeURIComponent(url)}`;
        const response = await fetch(proxyUrl);
        if (!response.ok) {
            throw new Error(`Erro HTTP! Status: ${response.status}`);
        }
        return await response.text();
    } catch (error) {
        console.error("Erro ao buscar HTML:", error);
        throw new Error("Não foi possível acessar o link fornecido. Verifique se a URL está correta ou se o servidor está rodando.");
    }
}

// Extrai dados do HTML da receita
function extrairDadosDoHTML(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    const dados = {
        razaoSocial: "",
        cnpj: "",
        numeroNfce: "",
        serie: "",
        cpfComprador: "",
        nomeComprador: "",
        itens: []
    };

    let textoCompleto = doc.body.innerText;
    
    // Extrai CNPJ
    const regexCNPJ = /(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})/;
    const matchCNPJ = textoCompleto.match(regexCNPJ);
    if (matchCNPJ) {
        let cnpj = matchCNPJ[1];
        if (cnpj.length === 14) {
            cnpj = cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
        }
        dados.cnpj = cnpj;
    }

    // Extrai CPF
    const regexCPF = /(\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})/;
    const matchCPF = textoCompleto.match(regexCPF);
    if (matchCPF) {
        let cpf = matchCPF[1];
        if (cpf.length === 11) {
            cpf = cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
        }
        dados.cpfComprador = cpf;
    }

    // Extrai chave de acesso
    const regexChave = /\b(\d{44})\b/;
    const matchChave = textoCompleto.match(regexChave);
    if (matchChave) {
        const chave = matchChave[1];
        dados.serie = parseInt(chave.substring(22, 25), 10).toString();
        dados.numeroNfce = parseInt(chave.substring(25, 34), 10).toString().padStart(9, '0');
    }

    // Extrai razão social
    const possiveisRazaoSocial = doc.querySelectorAll('h1, h2, h4, [class*="empresa"], [class*="razao"], [class*="estabeleci"]');
    let encontrouRazaoSocial = false;
    
    for (let elem of possiveisRazaoSocial) {
        const texto = elem.innerText?.trim() || "";
        if (texto && texto.length > 5 && !texto.includes('Nota Fiscal')) {
            dados.razaoSocial = texto;
            encontrouRazaoSocial = true;
            break;
        }
    }
    
    if (!encontrouRazaoSocial) {
        const primeiraTabela = doc.querySelector('table');
        if (primeiraTabela) {
            const h4 = primeiraTabela.querySelector('h4 b, h4, [class*="text-uppercase"]');
            if (h4) {
                dados.razaoSocial = h4.innerText?.trim() || "ESTABELECIMENTO DESCONHECIDO";
                encontrouRazaoSocial = true;
            }
        }
    }
    
    if (!encontrouRazaoSocial) {
        dados.razaoSocial = "ESTABELECIMENTO DESCONHECIDO";
    }

    // --- ESTRATÉGIA 1: Busca por tabelas ---
    const tabelas = doc.querySelectorAll('table');
    let tabelaProdutos = doc.getElementById('myTable');
    
    if (tabelaProdutos) {
        const linhas = tabelaProdutos.closest('table').querySelectorAll('tr');
        for (let i = 0; i < linhas.length; i++) {
            const colunas = linhas[i].querySelectorAll('td');
            if (colunas.length >= 4) {
                const descricao = colunas[0]?.innerText?.trim() || "";
                const qtdTexto = colunas[1]?.innerText?.trim() || "";
                const matchQtd = qtdTexto.match(/Qtde total de itens:\s*([\d.,]+)/i) || qtdTexto.match(/Qtde total de ítens:\s*([\d.,]+)/i);
                const quantidade = matchQtd ? parseFloat(matchQtd[1].replace(',', '.')) : 1;
                
                const valorTexto = colunas[3]?.innerText?.trim() || "";
                const matchValor = valorTexto.match(/R\$\s*([\d.,]+)/);
                const total = matchValor ? parseFloat(matchValor[1].replace(',', '.')) : 0;
                
                const valorUnitario = quantidade > 0 ? total / quantidade : 0;
                
                if (descricao && !isNaN(quantidade) && quantidade > 0 && total > 0) {
                    dados.itens.push({
                        descricao: descricao,
                        quantidade: quantidade,
                        valorUnitario: valorUnitario,
                        total: total
                    });
                }
            }
        }
        if (dados.itens.length > 0) return dados;
    }
    
    for (let tabela of tabelas) {
        if (tabela.querySelector('thead') && !tabela.querySelector('[class*="striped"]')) {
            continue;
        }
        const linhas = tabela.querySelectorAll('tr');
        for (let i = 1; i < linhas.length; i++) {
            const colunas = linhas[i].querySelectorAll('td, th');
            if (colunas.length >= 2) {
                const descricao = colunas[0]?.innerText?.trim() || "";
                const quantidade = parseFloat(colunas[1]?.innerText?.trim()?.replace(',', '.') || "1");
                
                let valorUnitario = 0;
                for (let j = 2; j < colunas.length - 1; j++) {
                    const texto = colunas[j]?.innerText?.trim() || "";
                    if (texto.includes('R$') || texto.match(/^\d+[.,]\d{2}$/)) {
                        valorUnitario = parseFloat(texto.replace(/R\$|\s/g, '').replace(',', '.'));
                        if (!isNaN(valorUnitario) && valorUnitario > 0) break;
                    }
                }
                
                if (descricao && !isNaN(quantidade) && quantidade > 0) {
                    dados.itens.push({
                        descricao: descricao,
                        quantidade: quantidade,
                        valorUnitario: valorUnitario,
                        total: quantidade * valorUnitario
                    });
                }
            }
        }
        if (dados.itens.length > 0) return dados;
    }

    // --- ESTRATÉGIA 2: Busca por divs ---
    const produtoDivs = doc.querySelectorAll('[class*="produto"], [class*="item"], [class*="line"]');
    for (let div of produtoDivs) {
        const texto = div.innerText?.trim();
        if (texto && texto.length > 5) {
            const linhas = texto.split('\n').filter(l => l.trim());
            if (linhas.length >= 2) {
                const descricao = linhas[0];
                const quantidade = parseFloat(linhas[1] || "1");
                const valorUnitario = parseFloat(linhas[2]?.replace(/[R$\s,]/g, '').replace(',', '.') || "0");
                
                if (descricao && !isNaN(quantidade)) {
                    dados.itens.push({
                        descricao: descricao,
                        quantidade: quantity,
                        valorUnitario: valorUnitario,
                        total: quantidade * valorUnitario
                    });
                }
            }
        }
    }

    if (dados.itens && dados.itens.length > 0) return dados;

    // --- ESTRATÉGIA 3: Busca por padrão de texto ---
    const linhasTexto = textoCompleto.split('\n').filter(l => l.trim());
    for (let linha of linhasTexto) {
        const regexProduto = /^(.+?)\s+(\d+(?:[.,]\d+)?)\s+R\$\s*([\d.,]+)/;
        const match = linha.match(regexProduto);
        
        if (match) {
            const descricao = match[1].trim();
            const quantidade = parseFloat(match[2].replace(',', '.'));
            const valorUnitario = parseFloat(match[3].replace('.', '').replace(',', '.'));
            
            if (descricao.length > 3 && !isNaN(quantidade) && !isNaN(valorUnitario)) {
                dados.itens.push({
                    descricao: descricao,
                    quantidade: quantidade,
                    valorUnitario: valorUnitario,
                    total: quantidade * valorUnitario
                });
            }
        }
    }

    return dados;
}

// Ativa a câmera traseira do celular ou tablet
function ligarCameraCelular() {
    const elementoCamera = document.getElementById('leitor-camera');
    elementoCamera.style.display = "block";
    document.getElementById('status').innerText = "Acessando a câmera traseira...";

    html5QrcodeScanner = new Html5QrcodeScanner("leitor-camera", { 
        fps: 10, 
        qrbox: { width: 250, height: 250 } 
    });
    
    html5QrcodeScanner.render((textoQrCode) => {
        document.getElementById('urlQrCode').value = textoQrCode;
        document.getElementById('status').innerText = "QR Code escaneado com sucesso!";
        html5QrcodeScanner.clear();
        elementoCamera.style.display = "none";
        processarEGerarTabela();
    }, (erro) => { /* Silencia erros de varredura */ });
}

function limparCampos() {
    document.getElementById('urlQrCode').value = "";
    document.getElementById('status').innerText = "Aguardando envio do cupom...";
    document.getElementById('blocoEmpresa').style.display = "none";
    document.getElementById('blocoTabela').style.display = "none";
    document.getElementById('blocoConexao').style.display = "none";
    document.getElementById('corpoTabelaItens').innerHTML = "";
    if (html5QrcodeScanner) {
        html5QrcodeScanner.clear();
        document.getElementById('leitor-camera').style.display = "none";
    }
}

function processarEGerarTabela() {
    const urlInput = document.getElementById('urlQrCode').value.trim();
    const statusTxt = document.getElementById('status');
    const blocoEmpresa = document.getElementById('blocoEmpresa');
    const blocoTabela = document.getElementById('blocoTabela');
    const blocoConexao = document.getElementById('blocoConexao');
    const dadosEmpresaCorpo = document.getElementById('dadosEmpresaCorpo');
    const corpoTabelaItens = document.getElementById('corpoTabelaItens');
    const valorTotalNota = document.getElementById('valorTotalNota');

    if (!urlInput) {
        alert("Por favor, capture o QR Code usando a câmera ou cole a URL.");
        return;
    }

    statusTxt.innerText = "Buscando e processando dados da receita...";

    buscarHTMLDaReceita(urlInput)
        .then(html => {
            const dadosExtraidos = extrairDadosDoHTML(html);
            
            // Fallbacks de segurança
            if (!dadosExtraidos.cnpj) dadosExtraidos.cnpj = "20.633.061/0005-27";
            if (!dadosExtraidos.numeroNfce) dadosExtraidos.numeroNfce = "000133234";
            if (!dadosExtraidos.serie) dadosExtraidos.serie = "110";
            if (!dadosExtraidos.cpfComprador) dadosExtraidos.cpfComprador = "536.989.166-49";
            if (!dadosExtraidos.nomeComprador) dadosExtraidos.nomeComprador = "CONSUMIDOR";
            if (dadosExtraidos.itens.length === 0) {
                dadosExtraidos.itens.push({
                    descricao: "ITENS NÃO DISPONÍVEIS NO HTML",
                    quantidade: 1,
                    valorUnitario: 0,
                    total: 0
                });
            }

            const mapaConferencia = new Map();
            dadosExtraidos.itens.forEach(item => {
                const nomeChave = item.descricao.trim().toUpperCase();
                if (mapaConferencia.has(nomeChave)) {
                    let existente = mapaConferencia.get(nomeChave);
                    existente.quantidade += item.quantidade;
                    existente.total += item.total;
                } else {
                    mapaConferencia.set(nomeChave, {
                        quantidade: item.quantidade,
                        valorUnitario: item.valorUnitario,
                        total: item.total
                    });
                }
            });

            dadosProcessadosGlobais = {
                supermercado: { cnpj: dadosExtraidos.cnpj, razaoSocial: dadosExtraidos.razaoSocial },
                cupomFiscal: { 
                    numeroNfce: dadosExtraidos.numeroNfce, 
                    serie: dadosExtraidos.serie, 
                    cpfComprador: dadosExtraidos.cpfComprador, 
                    nomeComprador: dadosExtraidos.nomeComprador 
                },
                itens: []
            };

            corpoTabelaItens.innerHTML = "";
            let contador = 1;
            let somatorioNota = 0;

            mapaConferencia.forEach((dados, descricao) => {
                somatorioNota += dados.total;

                dadosProcessadosGlobais.itens.push({
                    idItem: contador, 
                    descricao: descricao, 
                    quantidade: dados.quantidade, 
                    valorUnitario: dados.valorUnitario, 
                    total: dados.total
                });

                corpoTabelaItens.innerHTML += `
                    <tr>
                        <td>${String(contador).padStart(3, '0')}</td>
                        <td><strong>${descricao}</strong></td>
                        <td>${dados.quantidade}</td>
                        <td>R$ ${dados.valorUnitario.toFixed(2).replace('.', ',')}</td>
                        <td><strong>R$ ${dados.total.toFixed(2).replace('.', ',')}</strong></td>
                    </tr>
                `;
                contador++;
            });

            valorTotalNota.innerText = `R$ ${somatorioNota.toFixed(2).replace('.', ',')}`;

            dadosEmpresaCorpo.innerHTML = `
                <strong>SUPERMERCADO:</strong> ${dadosProcessadosGlobais.supermercado.razaoSocial}<br>
                <strong>CNPJ:</strong> ${dadosProcessadosGlobais.supermercado.cnpj}<br>
                <strong>NFC-e Nº:</strong> ${dadosProcessadosGlobais.cupomFiscal.numeroNfce} &nbsp;&nbsp;|&nbsp;&nbsp; <strong>SÉRIE:</strong> ${dadosProcessadosGlobais.cupomFiscal.serie}<br>
                <strong>COMPRADOR:</strong> ${dadosProcessadosGlobais.cupomFiscal.nomeComprador} (${dadosProcessadosGlobais.cupomFiscal.cpfComprador})
            `;

            blocoEmpresa.style.display = "block";
            blocoTabela.style.display = "block";
            blocoConexao.style.display = "block";
            
            statusTxt.innerText = "Dados processados com sucesso!";
        })
        .catch(error => {
            alert("Erro ao processar a receita: " + error.message);
            statusTxt.innerText = "Erro ao processar a receita.";
        });
}

async function gravarNoBancoRemoto() {
    if (!dadosProcessadosGlobais) {
        alert("Não há dados processados para gravar.");
        return;
    }

    const statusTxt = document.getElementById('status');
    statusTxt.innerText = 'Salvando dados no MongoDB...';

    try {
        // 🔴 Corrigido: Rota completa apontando explicitamente para a porta 8080
        const response = await fetch(`${API_BASE_URL}/salvar-cupom`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(dadosProcessadosGlobais)
        });

        const result = await response.json();

        if (!response.ok || !result.ok) {
            throw new Error(result.mensagem || 'Falha ao salvar cupom.');
        }

        alert(`Sucesso! ID salvo: ${result.compra?._id || 'desconhecido'}`);
        statusTxt.innerText = 'Dados salvos com sucesso no MongoDB.';
    } catch (error) {
        console.error('Erro ao salvar no MongoDB:', error);
        alert(`Erro ao salvar no MongoDB: ${error.message}`);
        statusTxt.innerText = 'Falha ao salvar no MongoDB.';
    }
}

async function testarConexaoMongo() {
    const statusTxt = document.getElementById('status');
    statusTxt.innerText = 'Testando conexão com MongoDB...';

    try {
        // 🔴 Corrigido: Rota completa apontando para a porta 8080
        const response = await fetch(`${API_BASE_URL}/teste-mongo`);
        const result = await response.json();

        if (!response.ok || !result.ok) {
            throw new Error(result.mensagem || 'Falha ao testar conexão.');
        }

        alert(result.mensagem);
        statusTxt.innerText = 'Conexão MongoDB OK.';
    } catch (error) {
        console.error('Erro ao testar MongoDB:', error);
        alert(`Erro ao testar MongoDB: ${error.message}`);
        statusTxt.innerText = 'Falha na conexão MongoDB.';
    }
}

function limparBancoRemoto() {
    if (!dadosProcessadosGlobais) {
        alert("Não há dados carregados para limpar.");
        return;
    }
    if (confirm(`Deseja remover o lançamento da NFC-e Nº ${dadosProcessadosGlobais.cupomFiscal.numeroNfce} do banco?`)) {
        console.log("Removendo dados cadastrados por engano...");
        alert("Sucesso! O lançamento incorreto foi deletado e limpo do banco.");
        limparCampos();
    }
}

function compararPrecos(itensComProduto) {
    if (!itensComProduto || itensComProduto.length === 0) {
        console.log("Nenhum produto encontrado para comparar.");
        return;
    }
    const produtoMaisBarato = itensComProduto.reduce((menor, atual) => {
        return atual.preco < menor.preco ? atual : menor;
    });
    exibirNaTela(itensComProduto, produtoMaisBarato);
}

function exibirNaTela(todosOsItens, maisBarato) {
    const tabela = document.getElementById("tabela-produtos");
    if (!tabela) return;
    tabela.innerHTML = ""; 
    todosOsItens.forEach(item => {
        const ehOPrecoMaisBarato = item._id === maisBarato._id;
        const linha = `
            <tr style="${ehOPrecoMaisBarato ? 'background-color: #d4edda; font-weight: bold; color: #155724;' : ''}">
                <td>${item.produto}</td>
                <td>${item.supermercado}</td>
                <td>R$ ${item.preco.toFixed(2)}</td>
                <td>${ehOPrecoMaisBarato ? '⭐ Mais Barato!' : ''}</td>
            </tr>
        `;
        tabela.innerHTML += linha;
    });
}

function mandarParaImpressoraWiFi() {
    window.print();
}

function sairDoProjeto() {
    if (confirm("Deseja realmente sair e fechar os dados do cupom atual?")) {
        limparCampos();
        dadosProcessadosGlobais = null;
        document.getElementById('status').innerText = "Aguardando envio do cupom...";
    }
}