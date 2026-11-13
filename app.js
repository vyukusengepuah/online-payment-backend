// ==========================================
// 1. LES IMPORTS
// ==========================================
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { db, dbUat } = require('./db');
const axios = require('axios');
const https = require('https');

dotenv.config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 2. ROUTES POUR LE 2 STEP (AUTHENTIFICATION)
// ==========================================

app.post('/routes/auth', async (req, res) => {
    try {
        const { username, pwd } = req.body; 
        const user = await db('users').where({ username: username }).first();
        if (!user) return res.status(404).json({ response: "non", message: "Utilisateur introuvable" });
        if (user.password !== pwd) return res.status(401).json({ response: "non", message: "Mot de passe incorrect" });

        const otpCode = Math.floor(100000 + Math.random() * 900000);
        console.log(`🔐 CODE OTP POUR ${username} : ${otpCode}`);
        return res.status(200).json({ response: "ok", message: "Connexion réussie", data: { ID: user.id, USERNAME: user.username, EMAIL: user.email || "test@test.com", FOTO: null } });
    } catch (error) {
        return res.status(500).json({ response: "non", message: "Erreur serveur" });
    }
});

app.post('/getway/post', async (req, res) => {
    try {
        if (req.query.path && req.query.path.includes('check_otp')) {
            const { OTP } = req.body;
            if (OTP && OTP.length === 6) return res.status(200).json({ success: true, message: "Code OTP validé", response: "ok" });
            else return res.status(400).json({ success: false, error: "Code OTP invalide", response: "non" });
        }
        return res.status(404).json({ response: "non", message: "Route gateway non trouvée" });
    } catch (error) {
        return res.status(500).json({ success: false, error: "Erreur serveur" });
    }
});

// ==========================================
// 3. GESTION DES ENVIRONNEMENTS
// ==========================================

// 3.1 Lister tous les environnements
app.get('/routes/environments', async (req, res) => {
    try {
        const envs = await db('environments').select('*');
        res.status(200).json({ response: "ok", data: envs });
    } catch (error) {
        res.status(500).json({ response: "non", message: error.message });
    }
});

// 3.2 Créer un environnement (avec Keycloak et choix de la base cible)
app.post('/routes/environments', async (req, res) => {
    try {
        const { 
            gateway_url, 
            client_id, 
            merchantCode, 
            merchantPin, 
            customerAccount, 
            amount, 
            description, 
            type, 
            modeSecret,
            baseCible 
        } = req.body;

        // Vérifier si l'environnement existe déjà dans la base locale
        const exist = await db('environments').where({ merchantCode }).first();
        if (exist) {
            return res.status(400).json({ response: "non", message: "Environnement existant" });
        }

        // ÉTAPE KEYCLOAK : Obtenir le token d'administration
        const tokenResponse = await axios.post(
            'http://192.168.53.53:8180/realms/master/protocol/openid-connect/token',
            new URLSearchParams({
                client_id: 'backend-crud',
                client_secret: 'NszBhLTPjxkzuCkvl3K7lJHqdymKdW8A',
                username: 'admin',
                password: 'admin',
                grant_type: 'password'
            })
        );
        const adminToken = tokenResponse.data.access_token;

        // Vérifier si le client existe déjà dans Keycloak
        const searchResponse = await axios.get(
            `http://192.168.53.53:8180/admin/realms/gateway-server/clients?clientId=${client_id}`,
            { headers: { Authorization: `Bearer ${adminToken}` } }
        );

        let keycloakInternalId;
        let nouveauSecret;

        if (searchResponse.data.length > 0) {
            keycloakInternalId = searchResponse.data[0].id;
            if (modeSecret === 'regenerer') {
                const secretResponse = await axios.post(
                    `http://192.168.53.53:8180/admin/realms/gateway-server/clients/${keycloakInternalId}/client-secret`,
                    {},
                    { headers: { Authorization: `Bearer ${adminToken}` } }
                );
                nouveauSecret = secretResponse.data.value;
            } else {
                const secretResponse = await axios.get(
                    `http://192.168.53.53:8180/admin/realms/gateway-server/clients/${keycloakInternalId}/client-secret`,
                    { headers: { Authorization: `Bearer ${adminToken}` } }
                );
                nouveauSecret = secretResponse.data.value;
            }
        } else {
            await axios.post(
                'http://192.168.53.53:8180/admin/realms/gateway-server/clients',
                {
                    clientId: client_id,
                    name: `Client ${merchantCode}`,
                    enabled: true,
                    publicClient: false,
                    serviceAccountsEnabled: true,
                    directAccessGrantsEnabled: true,
                    secret: "temporaire_pour_creation"
                },
                { headers: { Authorization: `Bearer ${adminToken}` } }
            );

            const newSearchResponse = await axios.get(
                `http://192.168.53.53:8180/admin/realms/gateway-server/clients?clientId=${client_id}`,
                { headers: { Authorization: `Bearer ${adminToken}` } }
            );
            keycloakInternalId = newSearchResponse.data[0].id;

            const secretResponse = await axios.post(
                `http://192.168.53.53:8180/admin/realms/gateway-server/clients/${keycloakInternalId}/client-secret`,
                {},
                { headers: { Authorization: `Bearer ${adminToken}` } }
            );
            nouveauSecret = secretResponse.data.value;
        }

        // ==========================================
        // ENREGISTREMENT SELON LA BASE CIBLE
        // ==========================================

        // 4.1 Enregistrement dans la base LOCALE
        if (baseCible === 'local' || baseCible === 'both') {
            await db('environments').insert({
                gateway_url,
                client_id: client_id,
                client_secret: nouveauSecret,
                merchantCode,
                merchantPin,
                customerAccount,
                amount,
                description,
                type
            });
            console.log("✅ Enregistré dans la base locale (environments)");
        }

        // 4.2 Enregistrement dans la base UAT
        if (baseCible === 'uat' || baseCible === 'both') {
            if (type === 'BILLER') {
                await dbUat('client_bet').insert({
                    BillerCode: merchantCode,
                    name: description || 'N/A',
                    url_callback: '',
                    compte: customerAccount,
                    lonaBettingCompanyId: null
                });
                console.log("✅ Enregistré dans la base UAT (client_bet)");
            } else {
                await dbUat('client').insert({
                    merchantCode: merchantCode,
                    name: description || 'N/A',
                    url_callback: ''
                });
                console.log("✅ Enregistré dans la base UAT (client)");
            }
        }

        res.status(201).json({ 
            response: "ok", 
            message: "Environnement créé avec succès",
            client_id: client_id,
            client_secret: nouveauSecret
        });

    } catch (error) {
        console.error("Erreur:", error.response ? error.response.data : error.message);
        res.status(500).json({ response: "non", message: "Erreur création", details: error.response ? error.response.data : error.message });
    }
});

// ==========================================
// 4. OBTENTION DU TOKEN (STOCKAGE AVEC TIMESTAMP)
// ==========================================

app.post('/routes/token', async (req, res) => {
    try {
        const { merchantCode } = req.body;
        const env = await db('environments').where({ merchantCode }).first();
        if (!env) return res.status(400).json({ response: "non", message: "Environnement introuvable" });

        if (!env.client_id || !env.client_secret) {
            return res.status(400).json({ response: "non", message: "Identifiants Keycloak manquants" });
        }

        const gatewayUrl = env.gateway_url || "https://192.168.53.53:8443";

        const tokenResponse = await axios.post(
            `${gatewayUrl}/auth/token`,
            new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: env.client_id,
                client_secret: env.client_secret
            }),
            { 
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                httpsAgent: new https.Agent({ rejectUnauthorized: false })
            }
        );

        const accessToken = tokenResponse.data.access_token;

        const expiresAt = new Date().getTime() + 60000;
        const tokenWithExpiry = `${accessToken}|${expiresAt}`;

        await db('environments').where({ merchantCode }).update({ 
            access_token: tokenWithExpiry
        });

        const envMisAJour = await db('environments').where({ merchantCode }).first();

        res.status(200).json({ response: "ok", access_token: accessToken, environment: envMisAJour });
    } catch (error) {
        console.error("Erreur token:", error.response ? error.response.data : error.message);
        res.status(500).json({ response: "non", message: "Erreur token", details: error.response ? error.response.data : error.message });
    }
});

// ==========================================
// 5. INITIATION DU PAIEMENT (MERCHANT ou BILLER)
// ==========================================

app.post('/routes/initier-paiement', async (req, res) => {
    try {
        const { merchantTransID, merchantCode, amount, customerAccount, description, merchantPin } = req.body;

        // 1. Récupérer l'environnement
        const env = await db('environments').where({ merchantCode }).first();
        if (!env) return res.status(400).json({ response: "non", message: "Environnement introuvable" });

        // 2. Vérifier le token
        if (!env.access_token) {
            return res.status(400).json({ response: "non", message: "Token manquant. Veuillez obtenir un token." });
        }

        const parts = env.access_token.split('|');
        const token = parts[0];
        const expiryTimestamp = parseInt(parts[1]);
        const now = new Date().getTime();

        if (now > expiryTimestamp) {
            return res.status(400).json({ response: "non", message: "Token expiré. Veuillez obtenir un nouveau token." });
        }

        const gatewayUrl = env.gateway_url || "https://192.168.53.53:8443";

        // 3. Choix de l'endpoint selon le type
        let endpoint = '';
        let body = {};

        if (env.type === 'BILLER') {
            endpoint = `${gatewayUrl}/merchant-payment/bet/deposit`;
            body = {
                DebitAccount: customerAccount,
                Remarks: description,
                Amount: amount,
                BillerCode: merchantCode,
                TransactionId: merchantTransID
            };
        } else {
            endpoint = `${gatewayUrl}/merchant-payment/pay/merchant`;
            body = {
                merchantTransID,
                merchantCode,
                amount,
                customerAccount,
                description,
                merchantPin
            };
        }

        // 4. Appel à l'API Bancobu
        const paiementResponse = await axios.post(
            endpoint,
            body,
            { 
                headers: { Authorization: `Bearer ${token}` },
                httpsAgent: new https.Agent({ rejectUnauthorized: false })
            }
        );

        // ==========================================
        // 5. GESTION DES DEUX FORMATS DE RÉPONSE
        // ==========================================
        const statusCode = paiementResponse.data.statusCode || paiementResponse.data.ResultCode;
        const transactionID = paiementResponse.data.transactionID || paiementResponse.data.TransactionID;
        const status = paiementResponse.data.status || paiementResponse.data.Status;
        const reason = paiementResponse.data.reason || paiementResponse.data.Message || 'Aucune raison fournie';

        // 6. Enregistrement dans la table 'request'
        await db('request').insert({
            merchantTransID,
            merchantCode,
            amount,
            customerAccount,
            description,
            merchantPin
        });

        // 7. Enregistrement dans la table 'response'
        await db('response').insert({
            merchantTransID,
            statusCode,
            transactionID,
            status,
            reason
        });

        // 8. Mettre à jour l'environnement
        await db('environments').where({ merchantCode }).update({ 
            merchantTransID: merchantTransID,
            transactionID: transactionID 
        });

        const envMisAJour = await db('environments').where({ merchantCode }).first();

        // 9. Réponse au frontend
        res.status(200).json({ 
            response: "ok", 
            message: "Paiement initié", 
            data: {
                statusCode: statusCode,
                transactionID: transactionID,
                status: status,
                reason: reason
            },
            environment: envMisAJour
        });

    } catch (error) {
        console.error("Erreur paiement:", error.response ? error.response.data : error.message);
        res.status(500).json({ 
            response: "non", 
            message: "Erreur paiement", 
            details: error.response ? error.response.data : error.message 
        });
    }
});

// ==========================================
// 6. LANCEMENT DU SERVEUR
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`✅ Serveur démarré sur http://localhost:${PORT}`);
    db.raw('SELECT 1')
        .then(() => console.log(`✅ Connecté à la base de données ${process.env.DB_NAME}`))
        .catch((err) => console.error(`❌ Erreur de connexion à la base:`, err));
});