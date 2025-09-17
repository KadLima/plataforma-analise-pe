const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('crypto');

const router = express.Router();
const prisma = new PrismaClient();

// Criar nova sessão
router.post('/', async (req, res) => {
  try {
    const { url_base } = req.body;
    if (!url_base) return res.status(400).json({ error: 'url_base é obrigatório' });

    const session = await prisma.scanSession.create({
      data: {
        id: randomUUID(),
        url_base,
      },
    });
    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar sessão' });
  }
});

// Listar sessões
router.get('/', async (req, res) => {
  try {
    const sessions = await prisma.scanSession.findMany({ orderBy: { createdAt: 'desc' }});
    res.json(sessions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar sessões' });
  }
});

// Buscar sessão com links
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const session = await prisma.scanSession.findUnique({
      where: { id },
      include: { links: true }
    });
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });
    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar sessão' });
  }
});

// Atualizar sessão (status / total_links)
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, total_links } = req.body;
    const update = {};
    if (status) update.status = status;
    if (typeof total_links !== 'undefined') update.total_links = total_links;

    const session = await prisma.scanSession.update({
      where: { id },
      data: update
    });
    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao atualizar sessão' });
  }
});

module.exports = router;
