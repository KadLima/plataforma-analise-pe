import requests
import json

# O mesmo endereço e rota que nosso crawler tenta acessar
url_links = "http://localhost:3000/links"
session_id_teste = "session_teste_123"

# Dados de exemplo para enviar, imitando o que o crawler faz
link_data_exemplo = {
    "url": "http://exemplo.com/pagina-teste",
    "tipo": "EXTERNO",
    "origem": "http://localhost",
    "status": "Funcionando",
    "httpCode": 200,
    "finalUrl": "http://exemplo.com/pagina-teste",
    "session_id": session_id_teste
}

print(f"--- TENTANDO ENVIAR DADOS PARA: {url_links} ---")

try:
    # Tenta fazer a requisição POST, assim como o crawler
    response = requests.post(url_links, json=link_data_exemplo, timeout=10)
    
    print("\n--- CONEXÃO BEM-SUCEDIDA! ---")
    print(f"Status da Resposta do Servidor: {response.status_code}")
    
    # Tenta imprimir a resposta do servidor
    try:
        print("Dados recebidos do servidor:")
        print(json.dumps(response.json(), indent=2))
    except json.JSONDecodeError:
        print("Servidor respondeu, mas não em formato JSON:", response.text)
        
except requests.exceptions.RequestException as e:
    print("\n--- FALHA NA CONEXÃO ---")
    print("Ocorreu um erro CRÍTICO ao tentar se comunicar com o servidor.")
    print("Este é o erro exato que o crawler provavelmente está enfrentando.")
    print("\nErro Específico:", e)