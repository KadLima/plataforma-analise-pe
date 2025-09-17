import time
import random
import logging
import requests
import argparse
import json
from urllib.parse import urlparse, urljoin
from collections import deque
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import WebDriverException, TimeoutException

API_BASE_URL = "http://localhost:3000"
logging.basicConfig(filename='scanner_unificado.log', level=logging.INFO,
                    format='%(asctime)s - %(levelname)s - [%(session_id)s] - %(message)s')
REQUESTS_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36'
}


def enviar_link_api(link_data, session_id):
    try:
        link_data['session_id'] = session_id
        requests.post(f"{API_BASE_URL}/links", json=link_data, timeout=20)
    except requests.exceptions.RequestException as e:
        logging.error(f"API Exception (enviar_link): {e}")


def atualizar_sessao_api(session_id, status, total_links, depthReached=None, error_message=None):
    try:
        payload = {"status": status, "total_links": total_links}
        if depthReached is not None:
            payload['depthReached'] = depthReached
        if error_message is not None:
            payload['errorMessage'] = error_message
        requests.patch(f"{API_BASE_URL}/scan-session/{session_id}", json=payload, timeout=20)
    except requests.exceptions.RequestException as e:
        logging.error(f"API Exception (atualizar_sessao): {e}")


def atualizar_status_link_api(url, session_id, status, http_code=None, final_url=None, profundidade=None):
    try:
        payload = {"url": url, "session_id": session_id, "status": status}
        if http_code is not None:
            payload['httpCode'] = http_code
        if final_url is not None:
            payload['finalUrl'] = final_url
        if profundidade is not None:
            payload['profundidade'] = profundidade
        requests.patch(f"{API_BASE_URL}/links/by-url", json=payload, timeout=20)
    except requests.exceptions.RequestException as e:
        logging.error(f"API Exception (atualizar_status_link): {e}")


def verificar_link_status(url):
    try:
        resposta = requests.get(url, headers=REQUESTS_HEADERS, timeout=15, allow_redirects=True, stream=True)
        http_code = resposta.status_code
        final_url = resposta.url
        status = "Funcionando" if 200 <= http_code < 400 else f"Erro {http_code}"
        return {"status": status, "httpCode": http_code, "finalUrl": final_url}
    except requests.exceptions.RequestException:
        return {"status": "Inacessível", "httpCode": None, "finalUrl": url}


class Scanner:
    def __init__(self, base_url, session_id, max_depth, headless=True):
        self.base_url = base_url
        self.base_domain = urlparse(base_url).netloc
        self.session_id = session_id
        self.max_depth = max_depth
        self.logger = logging.LoggerAdapter(logging.getLogger(), {'session_id': self.session_id or 'Busca-Alvo'})
        try:
            chrome_options = Options()
            if headless:
                chrome_options.add_argument("--headless")
            chrome_options.add_argument("--start-maximized")
            chrome_options.add_argument("--disable-gpu")
            chrome_options.add_argument("--no-sandbox")
            chrome_options.add_experimental_option("prefs", {"profile.default_content_setting_values.popups": 1})
            self.driver = webdriver.Chrome(options=chrome_options)
            self.driver.set_page_load_timeout(45)
            self.logger.info(f"Webdriver do Chrome configurado. Headless={headless}")
        except Exception as e:
            self.logger.critical(f"ERRO CRÍTICO AO INICIAR O WEBDRIVER: {e}", exc_info=True)
            raise

    def classificar_link(self, link):
        if not link: return 'DESCONHECIDO'
        if link.startswith(('#', 'javascript:', 'mailto:', 'tel:')): return 'IGNORAR'
        if any(link.lower().split('?')[0].endswith(ext) for ext in
               ['.pdf', '.xls', '.xlsx', '.doc', '.docx', '.zip', '.rar', '.csv', '.jpg', '.png',
                '.gif']): return 'DOWNLOAD'
        link_domain = urlparse(link).netloc
        if self.base_domain in link_domain:
            return 'INTERNO'
        else:
            return 'EXTERNO'

    def buscar_links_alvo(self, links_alvo):
        resultados_encontrados = []
        alvos_ja_encontrados = set()
        queue = deque([(self.base_url, 0)])
        visitados = {self.base_url}
        max_depth_busca = 2
        self.logger.info(f"Iniciando busca direcionada por {len(links_alvo)} links em {self.base_url}")
        while queue:
            if len(alvos_ja_encontrados) == len(links_alvo):
                self.logger.info("Todos os links alvo foram encontrados. Encerrando a busca.")
                break
            url_atual, profundidade_atual = queue.popleft()
            if profundidade_atual > max_depth_busca: continue
            try:
                self.driver.get(url_atual)
                time.sleep(random.uniform(2, 4))
            except (WebDriverException, TimeoutException):
                self.logger.warning(f"Não foi possível carregar a página {url_atual} durante a busca.")
                continue
            links_na_pagina = self.driver.find_elements(By.TAG_NAME, 'a')
            for link in links_na_pagina:
                href = link.get_attribute('href')
                texto_do_link = link.text.lower()
                if not href: continue
                href_absoluto = urljoin(self.base_url, href)
                for alvo in links_alvo:
                    if alvo in alvos_ja_encontrados: continue
                    encontrou_no_href = alvo in href_absoluto
                    palavras_chave = [palavra for palavra in alvo.split('/') if palavra and '-' in palavra]
                    keywords_do_alvo = [kw.replace('-', ' ') for kw in palavras_chave]
                    encontrou_no_texto = False
                    if keywords_do_alvo:
                        encontrou_no_texto = all(kw_part in texto_do_link for kw_part in keywords_do_alvo[0].split())
                    if encontrou_no_href or encontrou_no_texto:
                        resultados_encontrados.append({"alvo": alvo, "origem": url_atual})
                        alvos_ja_encontrados.add(alvo)
                        self.logger.info(f"Link alvo '{alvo}' encontrado em: {url_atual}")
                        break
                if self.base_domain in href_absoluto and href_absoluto not in visitados:
                    visitados.add(href_absoluto)
                    queue.append((href_absoluto, profundidade_atual + 1))
        self.driver.quit()
        print(json.dumps(resultados_encontrados))

    def iniciar(self):
        self.profundidade_maxima_atingida = 0
        self.queue = deque([(self.base_url, 'INICIAL', 0)])
        self.links_na_fila = {self.base_url}
        self.total_links_found = 0
        self.logger.info(f"Iniciando varredura com profundidade máxima de {self.max_depth}.")
        links_para_verificar_no_final = []
        try:
            self.logger.info("FASE 1: Mapeando a estrutura do site (links internos)...")
            while self.queue:
                url_atual, origem, profundidade_atual = self.queue.popleft()
                self.profundidade_maxima_atingida = max(self.profundidade_maxima_atingida, profundidade_atual)
                atualizar_status_link_api(url_atual, self.session_id, "Verificando...", profundidade=profundidade_atual)
                self.logger.info(f"Processando [Profundidade {profundidade_atual}]: {url_atual}")
                try:
                    self.driver.get(url_atual)
                    time.sleep(random.uniform(2, 4))
                    atualizar_status_link_api(url_atual, self.session_id, "Funcionando",
                                              final_url=self.driver.current_url)
                except (WebDriverException, TimeoutException) as e:
                    self.logger.error(f"Não foi possível carregar a página {url_atual}: {e}")
                    if url_atual == self.base_url:
                        error_text = f"URL inicial inacessível: {e}"
                        atualizar_sessao_api(self.session_id, "erro", 0, 0, error_message=error_text)
                        return
                    atualizar_status_link_api(url_atual, self.session_id, "Inacessível")
                    continue
                if profundidade_atual >= self.max_depth:
                    self.logger.info(f"Limite de profundidade ({self.max_depth}) atingido.")
                    continue
                links_nesta_pagina = set()
                try:
                    last_height = self.driver.execute_script("return document.body.scrollHeight")
                    while True:
                        elementos = self.driver.find_elements(By.TAG_NAME, 'a')
                        for elemento in elementos:
                            href = elemento.get_attribute('href')
                            if href: links_nesta_pagina.add(href)
                        self.driver.execute_script("window.scrollBy(0, window.innerHeight);")
                        time.sleep(random.uniform(1.5, 3))
                        new_height = self.driver.execute_script("return document.body.scrollHeight")
                        if new_height == last_height: break
                        last_height = new_height
                except Exception as e:
                    self.logger.error(f"Erro durante a coleta incremental em {url_atual}: {e}")
                for link_href in links_nesta_pagina:
                    if link_href in self.links_na_fila: continue
                    self.links_na_fila.add(link_href)
                    self.total_links_found += 1
                    tipo = self.classificar_link(link_href)
                    if tipo == 'IGNORAR': continue
                    link_data = {"url": link_href, "tipo": tipo, "origem": url_atual,
                                 "profundidade": profundidade_atual + 1}
                    if tipo == 'DOWNLOAD' or tipo == 'EXTERNO':
                        links_para_verificar_no_final.append(link_href)
                        link_data['status'] = "Não verificado"
                        enviar_link_api(link_data, self.session_id)
                    elif tipo == 'INTERNO':
                        if profundidade_atual < self.max_depth:
                            self.queue.append((link_href, url_atual, profundidade_atual + 1))
                        link_data['status'] = "Na fila"
                        enviar_link_api(link_data, self.session_id)

            self.logger.info(
                f"FASE 2: Verificando {len(links_para_verificar_no_final)} links externos e de download...")
            for link_url in links_para_verificar_no_final:
                verificacao = verificar_link_status(link_url)
                atualizar_status_link_api(
                    link_url, self.session_id, verificacao["status"],
                    http_code=verificacao["httpCode"], final_url=verificacao["finalUrl"]
                )
                time.sleep(random.uniform(0.5, 1.5))
            atualizar_sessao_api(self.session_id, "finalizado", self.total_links_found,
                                 self.profundidade_maxima_atingida)
            self.logger.info("Varredura finalizada com sucesso.")
        except Exception as e:
            self.logger.critical(f"Erro crítico durante a varredura: {e}", exc_info=True)
            error_text = str(e)
            atualizar_sessao_api(self.session_id, "erro", self.total_links_found, self.profundidade_maxima_atingida,
                                 error_message=error_text)
        finally:
            if hasattr(self, 'driver'):
                self.driver.quit()
                self.logger.info("Navegador encerrado.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scanner unificado de links.")
    parser.add_argument("url", help="A URL base para iniciar a varredura.")
    parser.add_argument("--session-id", help="O ID da sessão para agrupar os resultados.")
    parser.add_argument("--depth", type=int, default=5, help="A profundidade máxima da varredura.")
    parser.add_argument("--find-links", help="Uma lista de URLs para encontrar, separadas por vírgula.")
    args = parser.parse_args()

    if args.find_links:
        scanner_busca = Scanner(base_url=args.url, session_id=None, max_depth=2, headless=False)
        links_alvo = args.find_links.split(',')
        scanner_busca.buscar_links_alvo(links_alvo)
    else:
        if not args.session_id:
            raise ValueError("O argumento --session-id é obrigatório para a varredura completa.")
        scanner_completo = Scanner(base_url=args.url, session_id=args.session_id, max_depth=args.depth,
                                   headless=False)  # Headless=False para abrir a janela
        scanner_completo.iniciar()