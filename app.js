// 1. Les imports
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const db = require('./db');
const axios = require('axios'); 

dotenv.config();

// 2. La création de l'application
const app = express();

// 3. Les middlewares
app.use(cors());
app.use(express.json());

// ==========================================
// ROUTES POUR LE 2 STEP (AUTHENTIFICATION)
// ==========================================

app.post('/routes/auth', async (req, res) => {
    try {
        const { username, pwd } = req.body; 
        console.log("Tentative de connexion pour :", username);

        const user = await db('users').where({ username: username }).first();

        if (!user) {
            return res.status(404).json({ response: "non", message: "Utilisateur introuvable" });
        }

        if (user.password !== pwd) {
            return res.status(401).json({ response: "non", message: "Mot de passe incorrect" });
        }

        const otpCode = Math.floor(100000 + Math.random() * 900000);
        console.log(`🔐 CODE OTP POUR ${username} : ${otpCode}`);

        return res.status(200).json({ 
            response: "ok", 
            message: "Connexion réussie",
            data: { ID: user.id, USERNAME: user.username, EMAIL: user.email || "test@test.com", FOTO: null } 
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ response: "non", message: "Erreur serveur" });
    }
});

app.post('/getway/post', async (req, res) => {
    try {
        if (req.query.path && req.query.path.includes('check_otp')) {
            const { OTP } = req.body;
            if (OTP && OTP.length === 6) {
                return res.status(200).json({ success: true, message: "Code OTP validé", response: "ok" });
            } else {
                return res.status(400).json({ success: false, error: "Code OTP invalide", response: "non" });
            }
        }
        return res.status(404).json({ response: "non", message: "Route gateway non trouvée" });
    } catch (error) {
        return res.status(500).json({ success: false, error: "Erreur serveur" });
    }
});

// ==========================================
// CRUD POUR LA TABLE CLIENTS (AVEC KEYCLOAK)
// ==========================================

// 1. Ajouter un client (MySQL + Keycloak)
app.post('/routes/clients', async (req, res) => {
    try {
        const { merchantCode, name, url_callback, type } = req.body;
        
        const exist = await db('clients').where({ merchantCode }).first();
        if (exist) {
            return res.status(400).json({ response: "non", message: "Ce code existe déjà dans MySQL" });
        }

        console.log("Tentative de création du client dans Keycloak...");
        
        // A. Obtenir le token d'admin
        const tokenResponse = await axios.post(
            'http://192.168.53.53:8180/realms/master/protocol/openid-connect/token',
            new URLSearchParams({
                client_id: 'admin-cli',
                client_secret: '88ScS7LGwkvySgDHWMtqcNzKwZZYp6m7',
                username: 'admin',
                password: 'admin',
                grant_type: 'password'
            })
        );
        const adminToken = tokenResponse.data.access_token;

        const keycloakClientId = `${type.toLowerCase()}_${name.toLowerCase()}_${merchantCode}`; 
        console.log("Création du client :", keycloakClientId);
        
        // B. Créer le client avec un secret temporaire
        await axios.post(
            'http://192.168.53.53:8180/admin/realms/gateway-server/clients',
            {
                clientId: keycloakClientId,
                name: name,
                enabled: true,
                publicClient: false,
                serviceAccountsEnabled: true,
                directAccessGrantsEnabled: true,
                secret: "temporaire_pour_creation" // Sera régénéré juste après
            },
            { headers: { Authorization: `Bearer ${adminToken}` } }
        );
        console.log("Client créé. Génération du secret aléatoire...");

        // C. Récupérer l'ID interne du client pour demander le nouveau secret
        const searchResponse = await axios.get(
            `http://192.168.53.53:8180/admin/realms/gateway-server/clients?clientId=${keycloakClientId}`,
            { headers: { Authorization: `Bearer ${adminToken}` } }
        );
        const keycloakInternalId = searchResponse.data[0].id;

        // D. DEMANDER À KEYCLOAK DE GÉNÉRER UN NOUVEAU SECRET
        const secretResponse = await axios.post(
            `http://192.168.53.53:8180/admin/realms/gateway-server/clients/${keycloakInternalId}/client-secret`,
            {},
            { headers: { Authorization: `Bearer ${adminToken}` } }
        );
        
        const nouveauSecret = secretResponse.data.value;
        console.log("Secret généré par Keycloak :", nouveauSecret);

        // 3. Sauvegarder dans MySQL
        await db('clients').insert({ merchantCode, name, url_callback, type });

        res.status(201).json({ 
            response: "ok", 
            message: "Client ajouté avec succès dans MySQL et Keycloak",
            keycloak_id: keycloakClientId,
            secret: nouveauSecret // On renvoie le secret au frontend
        });

    } catch (error) {
        console.error("--- ERREUR DÉTECTÉE ---");
        if (error.response) {
            console.error("Statut:", error.response.status);
            console.error("Données:", error.response.data);
        } else {
            console.error("Message:", error.message);
        }
        
        res.status(500).json({ 
            response: "non", 
            message: "Erreur lors de la création du client dans Keycloak",
            details: error.response ? error.response.data : error.message
        });
    }
});

// 2. Lister tous les clients
app.get('/routes/clients', async (req, res) => {
    try {
        const clients = await db('clients').select('*');
        res.status(200).json({ response: "ok", data: clients });
    } catch (error) {
        res.status(500).json({ response: "non", message: error.message });
    }
});

// 3. Supprimer un client (MySQL + Keycloak)
app.delete('/routes/clients/:code', async (req, res) => {
    try {
        const merchantCode = req.params.code;

        const exist = await db('clients').where({ merchantCode }).first();
        if (!exist) {
            return res.status(404).json({ response: "non", message: "Ce client n'existe pas dans MySQL" });
        }

        console.log("Suppression du client :", merchantCode);

        // A. Obtenir le token d'admin
        const tokenResponse = await axios.post(
            'http://192.168.53.53:8180/realms/master/protocol/openid-connect/token',
            new URLSearchParams({
                client_id: 'admin-cli',
                client_secret: '88ScS7LGwkvySgDHWMtqcNzKwZZYp6m7',
                username: 'admin',
                password: 'admin',
                grant_type: 'password'
            })
        );
        const adminToken = tokenResponse.data.access_token;

        // B. Trouver l'ID interne du client dans Keycloak
        const searchResponse = await axios.get(
            `http://192.168.53.53:8180/admin/realms/gateway-server/clients?clientId=${exist.type.toLowerCase()}_${exist.name.toLowerCase()}_${merchantCode}`,
            { headers: { Authorization: `Bearer ${adminToken}` } }
        );

        if (searchResponse.data.length > 0) {
            const keycloakInternalId = searchResponse.data[0].id;
            // C. Supprimer le client dans Keycloak
            await axios.delete(
                `http://192.168.53.53:8180/admin/realms/gateway-server/clients/${keycloakInternalId}`,
                { headers: { Authorization: `Bearer ${adminToken}` } }
            );
            console.log("Client supprimé avec succès dans Keycloak !");
        } else {
            console.log("Client introuvable dans Keycloak (déjà supprimé ?).");
        }

        // D. Supprimer dans MySQL
        await db('clients').where({ merchantCode }).del();

        res.status(200).json({ response: "ok", message: "Client supprimé avec succès dans MySQL et Keycloak" });

    } catch (error) {
        console.error("Erreur lors de la suppression:", error.response ? error.response.data : error.message);
        res.status(500).json({ response: "non", message: "Erreur lors de la suppression" });
    }
});

// ==========================================
// LANCEMENT DU SERVEUR
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`✅ Serveur démarré sur http://localhost:${PORT}`);
    db.raw('SELECT 1')
        .then(() => console.log(`✅ Connecté à la base de données ${process.env.DB_NAME}`))
        .catch((err) => console.error(`❌ Erreur de connexion à la base:`, err));
});