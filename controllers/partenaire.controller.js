const Model = require('../models/model');
exports.ajouterPartenaire = async (req, res) => {
    try {
        const { nom, email } = req.body;
        await Model.insert({ table: 'partenaires', culomn: { nom, email } });
        res.status(201).json({ message: "Partenaire ajouté avec succès" });
    } catch (error) { res.status(500).json({ message: error.message }); }
};
exports.listePartenaires = async (req, res) => {
    try {
        const partenaires = await Model.getList({ table: 'partenaires' });
        res.status(200).json(partenaires);
    } catch (error) { res.status(500).json({ message: error.message }); }
};
