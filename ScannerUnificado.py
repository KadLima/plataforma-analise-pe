import time
import random
import logging
import requests
import argparse
from urllib.parse import urlparse, urljoin
from collections import deque
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import WebDriverException, TimeoutException
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
# --- FERRAMENTAS PARA A FORÇA-TAREFA ---
from queue import Queue
from threading import Thread

API_BASE_URL = "http://localhost:3000"
logging.basicConfig(filename='scanner_unificado.log', level=logging.INFO,
                    format='%(asctime)s - %(levelname)s - [%(session_id)s] - %(message)s')
REQUESTS_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36'
}
PROXIES = {"http": None, "https": None}


def enviar_link_api(link_data, session_id):
    try:
        link_data['session_id'] = session_id
        requests.post(f"{API_BASE_URL}/links", json=link_data, timeout=20, proxies=PROXIES)
    except requests.exceptions.RequestException as e:
        logging.error(f"API Exception (enviar_link): {e}")


def atualizar_sessao_api(session_id, status, total_links, depthReached=None, error_message=None):
    try:
        payload = {"status": status, "total_links": total_links}
        if depthReached is not None:
            payload['depthReached'] = depthReached
        if error_message is not None:
            payload['errorMessage'] = error_message
        requests.patch(f"{API_BASE_URL}/scan-session/{session_id}", json=payload, timeout=20, proxies=PROXIES)
    except requests.exceptions.RequestException as e:
        logging.error(f"API Exception (atualizar_sessao): {e}")


def atualizar_status_link_api(url, session_id, status, http_code=None, final_url=None, profundidade=None):
    try:
        payload = {"url": url, "session_id": session_id, "status": status}
        if http_code is not None: payload['httpCode'] = http_code
        if final_url is not None: payload['finalUrl'] = final_url
        if profundidade is not None: payload['profundidade'] = profundidade
        requests.patch(f"{API_BASE_URL}/links/by-url", json=payload, timeout=20, proxies=PROXIES)
    except requests.exceptions.RequestException as e:
        logging.error(f"API Exception (atualizar_status_link): {e}")


def verificar_link_status(url):
    try:
        resposta = requests.head(url, headers=REQUESTS_HEADERS, timeout=10, allow_redirects=True, proxies=PROXIES)
        http_code = resposta.status_code
        final_url = resposta.url
        status = "Funcionando" if 200 <= http_code < 400 else f"Erro {http_code}"
        return {"status": status, "httpCode": http_code, "finalUrl": final_url}
    except requests.exceptions.RequestException:
        return {"status": "Timeout", "httpCode": None, "finalUrl": url}


class Scanner:
    def __init__(self, base_url, session_id, max_depth):
        self.base_url = base_url
        self.base_domain = urlparse(base_url).netloc
        self.session_id = session_id
        self.max_depth = max_depth
        self.queue = deque([(base_url, 'INICIAL', 0)])
        self.links_na_fila = {base_url}
        self.total_links_found = 0
        self.profundidade_maxima_atingida = 0
        self.logger = logging.LoggerAdapter(logging.getLogger(), {'session_id': self.session_id})
        try:
            chrome_options = Options()
            # chrome_options.add_argument("--headless")
            chrome_options.add_argument("--start-maximized")
            chrome_options.add_argument("--disable-gpu")
            chrome_options.add_argument("--no-sandbox")
            chrome_options.add_experimental_option("prefs", {"profile.default_content_setting_values.popups": 1})
            self.driver = webdriver.Chrome(options=chrome_options)
            self.driver.set_page_load_timeout(45)
            self.wait = WebDriverWait(self.driver, 10)
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

    # --- FUNÇÃO DO "TRABALHADOR" PARA A FORÇA-TAREFA ---
    def worker_verificador(self, q):
        while not q.empty():
            link_url = q.get()
            self.logger.info(f"Trabalhador verificando: {link_url}")
            verificacao = verificar_link_status(link_url)
            atualizar_status_link_api(
                link_url,
                self.session_id,
                verificacao["status"],
                http_code=verificacao["httpCode"],
                final_url=verificacao["finalUrl"]
            )
            q.task_done()

    def iniciar(self):
        self.logger.info(f"Iniciando varredura com profundidade máxima de {self.max_depth}.")
        links_para_verificar_no_final = []  # Lista de tarefas para a força-tarefa
        try:
            while self.queue:
                url_atual, origem, profundidade_atual = self.queue.popleft()
                self.profundidade_maxima_atingida = max(self.profundidade_maxima_atingida, profundidade_atual)
                atualizar_status_link_api(url_atual, self.session_id, "Verificando...", profundidade=profundidade_atual)
                try:
                    self.driver.get(url_atual)
                    self.wait.until(EC.presence_of_element_located((By.TAG_NAME, "body")))
                    atualizar_status_link_api(url_atual, self.session_id, "Funcionando",
                                              final_url=self.driver.current_url)
                except (WebDriverException, TimeoutException) as e:
                    self.logger.error(f"Não foi possível carregar a página {url_atual}: {e}")
                    atualizar_status_link_api(url_atual, self.session_id, "Timeout")
                    continue
                if profundidade_atual >= self.max_depth:
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
                        time.sleep(1.5)
                        new_height = self.driver.execute_script("return document.body.scrollHeight")
                        if new_height == last_height: break
                        last_height = new_height
                except Exception as e:
                    self.logger.error(f"Erro na coleta em {url_atual}: {e}")

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
                        self.queue.append((link_href, url_atual, profundidade_atual + 1))
                        link_data['status'] = "Na fila"
                        enviar_link_api(link_data, self.session_id)

                # --- CONDIÇÃO DA FORÇA-TAREFA ---
                if len(links_para_verificar_no_final) >= 10:
                    self.logger.info(
                        f"Acionando força-tarefa para verificar {len(links_para_verificar_no_final)} links...")
                    q = Queue()
                    for link_url in links_para_verificar_no_final:
                        q.put(link_url)

                    num_workers = 10
                    for _ in range(num_workers):
                        worker = Thread(target=self.worker_verificador, args=(q,))
                        worker.daemon = True
                        worker.start()

                    q.join()
                    links_para_verificar_no_final = []  # Esvazia a lista de tarefas
                    self.logger.info("Força-tarefa concluiu a verificação.")

            # --- VERIFICAÇÃO FINAL (para os links restantes que não chegaram a 10) ---
            if links_para_verificar_no_final:
                self.logger.info(
                    f"Verificando {len(links_para_verificar_no_final)} links restantes com a força-tarefa...")
                q = Queue()
                for link_url in links_para_verificar_no_final:
                    q.put(link_url)
                num_workers = 10
                for _ in range(num_workers):
                    worker = Thread(target=self.worker_verificador, args=(q,))
                    worker.daemon = True
                    worker.start()
                q.join()

            self.driver.quit()
            atualizar_sessao_api(self.session_id, "finalizado", self.total_links_found,
                                 self.profundidade_maxima_atingida)
            self.logger.info("Varredura finalizada com sucesso.")

        except Exception as e:
            self.logger.critical(f"Erro crítico durante a varredura: {e}", exc_info=True)
            error_text = str(e)
            atualizar_sessao_api(self.session_id, "erro", self.total_links_found, self.profundidade_maxima_atingida,
                                 error_message=error_text)

        finally:
            if hasattr(self, 'driver') and self.driver.session_id:
                try:
                    self.driver.quit()
                except Exception:
                    pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scanner unificado de links.")
    parser.add_argument("url", help="A URL base para iniciar a varredura.")
    parser.add_argument("--session-id", required=True, help="O ID da sessão para agrupar os resultados.")
    parser.add_argument("--depth", type=int, default=5, help="A profundidade máxima da varredura.")
    args = parser.parse_args()
    try:
        scanner = Scanner(base_url=args.url, session_id=args.session_id, max_depth=args.depth)
        scanner.iniciar()
    except Exception as e:
        logging.critical(f"Script finalizado por exceção: {e}", extra={'session_id': args.session_id})