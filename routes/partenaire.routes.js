const express = require('express');
const router = express.Router();
const partenaireController = require('../controllers/partenaire.controller');
router.post('/ajouter', partenaireController.ajouterPartenaire);
router.get('/liste', partenaireController.listePartenaires);
module.exports = router;
