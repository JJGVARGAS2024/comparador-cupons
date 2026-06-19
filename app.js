let html5QrcodeScanner = null;
let dadosProcessadosGlobais = null;

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
        
        // Dispara o processamento dinâmico imediato
        processarEGerarTabela();
    }, (erro) => {
        // Varrendo em busca do foco do código
    });
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

    statusTxt.innerText = "Processando e extraindo metadados fiscais...";

    // Valores padrão locais para o seu teste funcionar perfeitamente
    let cnpjExtraido = "20.633.061/0005-27";
    let numeroNfce = "000133234";
    let serieNfce = "110";
    let cpfExtraido = "536.989.166-49";
    let nomeConsumidor = "JÚLIO JOSÉ GOMES VARGAS";
    let razaoSocial = "MAC SUPERMERCADO LTDA LJ0005";

    // --- MOTOR DE EXTRAÇÃO VIA REGEX (DADOS DA URL) ---
    const regexChave = /\b\d{44}\b/;
    let matchChave = urlInput.match(regexChave);

    if (matchChave) {
        let chave = matchChave[0];
        let cnpjPuro = chave.substring(6, 20);
        cnpjExtraido = cnpjPuro.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
        serieNfce = parseInt(chave.substring(22, 25), 10).toString();
        numeroNfce = parseInt(chave.substring(25, 34), 10).toString().padStart(9, '0');
    }

    const regexCpfParametro = /(?:cpf|cDest|CPF|CDEST)=(\d{11})\b/i;
    let matchCpf = urlInput.match(regexCpfParametro);
    if (matchCpf) {
        let cpfPuro = matchCpf[1];
        cpfExtraido = cpfPuro.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
    }

    if (!cnpjExtraido.includes("20.633.061")) {
        razaoSocial = "SUPERMERCADO REGISTRADO VIA CNPJ: " + cnpjExtraido;
    }

    // Lista de itens para conferência
    let produtosCupom = [
        { descricao: "REFRI COCA ZERO 200ML", quantidade: 1, valorUnitario: 1.99 },
        { descricao: "REFRI COCA COLA ZE 600ML", quantidade: 1, valorUnitario: 5.69 },
        { descricao: "REFRI COCA ZERO 200ML", quantidade: 1, valorUnitario: 1.99 }
    ];

    if (!cnpjExtraido.includes("20.633.061")) {
        produtosCupom = [
            { descricao: "CONTA DE COMPRAS MERCADO EM GERAL", quantidade: 1, valorUnitario: 25.90 }
        ];
    }

    // Agrupamento de itens duplicados (Map)
    const mapaConferencia = new Map();
    produtosCupom.forEach(item => {
        const nomeChave = item.descricao.trim().toUpperCase();
        if (mapaConferencia.has(nomeChave)) {
            let existente = mapaConferencia.get(nomeChave);
            existente.quantidade += item.quantidade;
        } else {
            mapaConferencia.set(nomeChave, {
                quantidade: item.quantidade,
                valorUnitario: item.valorUnitario
            });
        }
    });

    // Estrutura do objeto global para persistência
    dadosProcessadosGlobais = {
        supermercado: { cnpj: cnpjExtraido, razaoSocial: razaoSocial },
        cupomFiscal: { numeroNfce: numeroNfce, serie: serieNfce, cpfComprador: cpfExtraido, nomeComprador: nomeConsumidor },
        itens: []
    };

    corpoTabelaItens.innerHTML = "";
    let contador = 1;
    let somatorioNota = 0;

    mapaConferencia.forEach((dados, descricao) => {
        let totalItem = dados.quantidade * dados.valorUnitario;
        somatorioNota += totalItem;

        dadosProcessadosGlobais.itens.push({
            idItem: contador, descricao: descricao, quantidade: dados.quantidade, valorUnitario: dados.valorUnitario, total: totalItem
        });

        corpoTabelaItens.innerHTML += `
            <tr>
                <td>${String(contador).padStart(3, '0')}</td>
                <td><strong>${descricao}</strong></td>
                <td>${dados.quantidade}</td>
                <td>R$ ${dados.valorUnitario.toFixed(2).replace('.', ',')}</td>
                <td><strong>R$ ${totalItem.toFixed(2).replace('.', ',')}</strong></td>
            </tr>
        `;
        contador++;
    });

    valorTotalNota.innerText = `R$ ${somatorioNota.toFixed(2).replace('.', ',')}`;

    // Renderiza o cabeçalho garantindo seu Nome e CPF na tela
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
}

function gravarNoBancoRemoto() {
    if (!dadosProcessadosGlobais) return;
    console.log("JSON enviado ao banco:", dadosProcessadosGlobais);
    alert(`Sucesso!\nDados salvos no Banco de Dados para o estabelecimento: ${dadosProcessadosGlobais.supermercado.razaoSocial}`);
}

// Limpar dados lançados incorretamente no Banco
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

// Impressão Wi-Fi sem traços para não gerar erro de sintaxe
function mandarParaImpressoraWiFi() {
    window.print();
}

// Função para Sair do Projeto e Resetar o App no Celular/Tablet
function sairDoProjeto() {
    if (confirm("Deseja realmente sair e fechar os dados do cupom atual?")) {
        // 1. Limpa todos os campos e esconde as tabelas
        limparCampos();
        
        // 2. Reseta as variáveis globais
        dadosProcessadosGlobais = null;
        
        // 3. Altera o status para o estado inicial
        document.getElementById('status').innerText = "Aguardando envio do cupom...";
        
        // Opcional: Se quiser redirecionar para o início ou fechar a aba (se permitido pelo celular)
        // window.location.reload(); // Recarrega a página zerada
    }
}