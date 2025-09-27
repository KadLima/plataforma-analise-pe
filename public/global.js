function protectPage() {
    const path = window.location.pathname;
    const protectedPages = ['/avaliacao-usuario', '/dashboard', '/scanner', '/formulario', '/admin', '/avaliacao']; 
    const isProtected = protectedPages.some(p => path.startsWith(p));
    const token = localStorage.getItem('authToken');

    if (isProtected && !token) {
        Swal.fire({
            icon: 'warning',
            title: 'Acesso Restrito',
            text: 'Você precisa estar logado para acessar esta página.',
            confirmButtonText: 'Fazer Login',
            confirmButtonColor: '#002776',
            allowOutsideClick: false
        }).then(() => {
            window.location.href = '/login';
        });
        return; // Para a execução aqui
    }

    /*const dataLiberacao = new Date('2025-11-14T00:00:00');
    const hoje = new Date();

    // Se a página é o formulário E hoje é ANTES da data de liberação
    if (path.startsWith('/formulario') && hoje < dataLiberacao) {
        // Precisamos verificar o cargo do usuário antes de bloquear
        // Esta chamada é assíncrona, então precisamos reestruturar um pouco
        fetch('http://localhost:3000/verify-token', {
            headers: { 'Authorization': `Bearer ${token}` }
        })
        .then(res => res.json())
        .then(data => {
            // Se o usuário NÃO for admin, bloqueia o acesso
            if (data.user && data.user.role !== 'ADMIN') {
                Swal.fire({
                    icon: 'info',
                    title: 'Aguarde a Liberação',
                    html: `A Autoavaliação estará disponível a partir de <strong>14 de Novembro de 2025</strong>.<br>Agradecemos a sua compreensão.`,
                    confirmButtonText: 'Voltar ao Início',
                    confirmButtonColor: '#002776',
                    allowOutsideClick: false
                }).then(() => {
                    window.location.href = '/';
                });
            }
        });
    }*/
}

// --- LÓGICA DO CABEÇALHO E LINKS DINÂMICOS ---
async function setupDynamicLinks() {
    const navLinks = document.getElementById('nav-links');
    const token = localStorage.getItem('authToken');
    let isLoggedIn = false;
    let user = null;

    if (token) {
        try {
            const response = await fetch('http://localhost:3000/verify-token', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (response.ok) {
                isLoggedIn = true;
                user = (await response.json()).user;
            } else {
                localStorage.removeItem('authToken');
            }
        } catch (error) { /* Assume deslogado */ }
    }

    if (isLoggedIn) {
        // --- O usuário ESTÁ logado ---
        if (isLoggedIn) {
            if (navLinks) {
                navLinks.innerHTML = `
                    <li><a href="/">Início</a></li>
                    <li><a href="/dashboard">Minha Área</a></li> <li><a href="/scanner">Scanner de Links</a></li>
                    <li><a href="/formulario">Autoavaliação</a></li>
                    <li><a id="logout-btn" ...>Sair</a></li>
                `;
            }
            const logoutBtn = document.getElementById('logout-btn');
            if (logoutBtn) {
                logoutBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    Swal.fire({
                        icon: 'question',
                        title: 'Confirmar Saída',
                        text: 'Você tem certeza que deseja encerrar a sessão?',
                        showCancelButton: true,
                        confirmButtonText: 'Sim, Sair',
                        cancelButtonText: 'Cancelar',
                        confirmButtonColor: '#dc3545', // CORRIGIDO: de var(--vermelho-destaque)
                        cancelButtonColor: '#6c757d'
                    }).then((result) => {
                        if (result.isConfirmed) {
                            localStorage.removeItem('authToken');
                            Swal.fire({
                                icon: 'info',
                                iconColor: '#002776', // CORRIGIDO: de var(--azul-gov-principal)
                                title: 'Você saiu!',
                                text: 'Sua sessão foi encerrada com sucesso.',
                                timer: 1500,
                                showConfirmButton: false
                            });
                            setTimeout(() => { window.location.href = '/'; }, 1500);
                        }
                    });
                });
            }
        }
    } else {
        // --- O usuário NÃO ESTÁ logado ---
        if (navLinks) {
            navLinks.innerHTML = `
                <li><a href="/">Início</a></li>
                <li><a href="/scanner">Scanner de Links</a></li>
                <li><a href="/login" style="font-weight: bold;">Login</a></li>
            `;
        }
    }
    
    // As funções para os links do card e do rodapé são chamadas aqui
    setupHomePageLinks(isLoggedIn);
    setupFooterLink(isLoggedIn, user); // Passa o objeto 'user'
}

function setupHomePageLinks(isLoggedIn) {
    const formCardLink = document.getElementById('form-card-link');
    if (formCardLink) {
        if (isLoggedIn) {
            formCardLink.href = '/formulario';
        } else {
            formCardLink.href = '/login';
        }
    }
}

// CORRIGIDO: A função agora recebe o objeto 'user'
function setupFooterLink(isLoggedIn, user) {
    const adminFooterLink = document.getElementById('admin-footer-link');
    if (!adminFooterLink) return;

    if (isLoggedIn && user && user.role === 'ADMIN') {
        adminFooterLink.style.display = 'inline';
        adminFooterLink.href = '/admin';
    } else {
        adminFooterLink.style.display = 'none';
    }
}

// --- EXECUÇÃO ---
protectPage();
document.addEventListener('DOMContentLoaded', setupDynamicLinks);