# Deployment

How the Notes app is deployed to Azure.

## Architecture

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│  Static Web  │      │  App Service │      │  Azure SQL   │
│     App      │─────▶│  (Linux, F1) │─────▶│  Serverless  │
│   (Free)     │ CORS │   .NET 10    │  MI  │  auto-pause  │
└──────────────┘      └──────┬───────┘      └──────────────┘
                             │ MI
                             ▼
                      ┌──────────────┐
                      │  Key Vault   │
                      │ (JWT key)    │
                      └──────────────┘
                             │
                      ┌──────┴───────┐
                      │  App Insights + Log Analytics │
                      └──────────────────────────────┘
```

| Layer         | Resource                     | SKU                                                            | Cost (idle → active) |
| ------------- | ---------------------------- | -------------------------------------------------------------- | -------------------- |
| Frontend      | Static Web Apps              | Free                                                           | $0                   |
| Backend       | App Service (Linux)          | F1                                                             | $0                   |
| Database      | Azure SQL                    | GP Serverless, 1 vCore, auto-pause 60 min, `useFreeLimit=true` | ~$0 when paused      |
| Secrets       | Key Vault                    | Standard                                                       | ~$0.03/mo            |
| Observability | Log Analytics + App Insights | Pay-as-you-go                                                  | ~$0 under free quota |

**Region:** `eastus2` · **Environments:** `dev`, `prod`

### Known tradeoffs of the free tier

- **SWA Free does not support linked backends.** The React app calls the App Service URL directly with CORS. The API hostname is visible to the browser.
- **F1 App Service** has no Always On, 60 min CPU/day, 1 GB RAM, shared infra. First request after idle (combined with SQL auto-pause) can take 30–90 s.
- Upgrading to **B1 App Service (~$13/mo) + SWA Standard (~$9/mo)** eliminates cold starts and enables same-origin `/api` proxying.

## Security model

- **GitHub → Azure:** OIDC federated identity. No client secrets.
- **App Service → SQL:** system-assigned managed identity; Entra-only auth (`Authentication=Active Directory Default`). No password anywhere.
- **App Service → Key Vault:** managed identity with `Key Vault Secrets User` role. JWT signing key is a Key Vault reference in app settings.
- No secrets in source control. No secrets in `.bicepparam` files. Environment-scoped variables only.

## Repository layout

```
infra/
├── main.bicep                  subscription-scope; creates RG + workload
├── main.dev.bicepparam         dev params (reads env vars, no literals)
├── main.prod.bicepparam        prod params
├── abbreviations.json          CAF naming prefixes
├── bootstrap/
│   └── setup-oidc.sh           one-time: create GitHub OIDC app regs
└── modules/
    ├── workload.bicep          orchestrator
    ├── log-analytics.bicep
    ├── app-insights.bicep
    ├── key-vault.bicep
    ├── sql.bicep               Entra-only, serverless, free limit
    ├── app-service.bicep       Linux F1, MI, KV ref, CORS
    └── static-web-app.bicep

.github/workflows/
├── ci.yml                      PR/push: build+test backend, frontend, bicep
├── infra-validate.yml          PR touching infra/**: what-if to PR summary
├── cd.yml                      push to main: build → deploy-dev → deploy-prod
└── _deploy.yml                 reusable deploy job
```

## First-time setup

### Prerequisites

- Azure CLI (`az`) logged in as a user with:
  - **Owner** or **User Access Administrator** on the target subscription
  - **Application Developer** (or better) in Entra ID
- GitHub `gh` CLI (optional, for setting env vars from the terminal)

### 1. Bootstrap OIDC (once per environment)

Creates an Entra app registration, federated credentials scoped to the GitHub environment, and assigns `Contributor` + `User Access Administrator` at subscription scope.

```bash
infra/bootstrap/setup-oidc.sh amis-4630 sample-app dev
infra/bootstrap/setup-oidc.sh amis-4630 sample-app prod
```

The script prints the exact variable values to paste into each GitHub Environment.

### 2. Configure GitHub Environments

In `https://github.com/amis-4630/sample-app/settings/environments`, create `dev` and `prod` environments and add these **variables** (not secrets — none are sensitive):

| Name                       | Value (dev example)    | Source                                                       |
| -------------------------- | ---------------------- | ------------------------------------------------------------ |
| `AZURE_CLIENT_ID`          | OIDC app reg client ID | bootstrap script output                                      |
| `AZURE_TENANT_ID`          | your tenant ID         | bootstrap script output                                      |
| `AZURE_SUBSCRIPTION_ID`    | target subscription    | bootstrap script output                                      |
| `AZURE_RESOURCE_GROUP`     | `rg-notes-dev`         | bootstrap script output                                      |
| `AZURE_LOCATION`           | `eastus2`              | bootstrap script output                                      |
| `AZURE_DEPLOYER_OBJECT_ID` | OIDC SP object ID      | bootstrap script output                                      |
| `SQL_ADMIN_OBJECT_ID`      | your user object ID    | `az ad signed-in-user show --query id -o tsv`                |
| `SQL_ADMIN_PRINCIPAL_NAME` | your UPN               | `az ad signed-in-user show --query userPrincipalName -o tsv` |

Enable **Required reviewers** on `prod`.

### 3. First deploy

Push to `main`. The `cd.yml` workflow:

1. Builds the backend (`dotnet publish`) and uploads `api.zip`.
2. Builds the frontend (sanity check).
3. Calls `_deploy.yml` for `dev`:
   - Ensures the resource group.
   - Runs `az deployment group create` with `main.dev.bicepparam`.
   - Seeds `jwt-signing-key` in Key Vault if missing (`openssl rand`).
   - Creates the App Service managed identity as a contained SQL user and grants `db_datareader/writer/ddladmin` via `sqlcmd` + Entra access token (runner IP is temporarily whitelisted and removed).
   - Deploys the API zip.
   - Rebuilds the frontend with `VITE_API_BASE_URL` set to the real App Service hostname and uploads to SWA.
4. On success, calls `_deploy.yml` for `prod` behind the reviewer gate.

## Day-to-day operations

### Validate Bicep locally

```bash
az bicep build --file infra/main.bicep
az bicep build-params --file infra/main.dev.bicepparam
```

### Preview changes (what-if)

Any PR that touches `infra/**` triggers `infra-validate.yml`, which posts a what-if diff to the PR summary. To run locally:

```bash
export SQL_ADMIN_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv)
export SQL_ADMIN_PRINCIPAL_NAME=$(az ad signed-in-user show --query userPrincipalName -o tsv)
az deployment group what-if \
  --resource-group rg-notes-dev \
  --template-file infra/main.bicep \
  --parameters infra/main.dev.bicepparam
```

### Manually trigger a deploy

`Actions → CD → Run workflow`, choose the environment.

### Rotate the JWT signing key

```bash
az keyvault secret set \
  --vault-name <kv-name> \
  --name jwt-signing-key \
  --value "$(openssl rand -base64 64 | tr -d '\n')"
az webapp restart --name <app-name> --resource-group rg-notes-<env>
```

Sessions issued with the previous key become invalid on restart.

### Tail logs

```bash
az webapp log tail --name <app-name> --resource-group rg-notes-<env>
```

Or query App Insights via the `<appi-notes-<env>>` resource in the portal.

### Tear down an environment

```bash
az group delete --name rg-notes-dev --yes --no-wait
```

Key Vault soft-delete is 7 days; if you recreate immediately, use a different name suffix or purge:

```bash
az keyvault purge --name <kv-name>
```

## App-code contract

The Bicep and workflows assume the application honors these environment variables / configuration keys. They are set by [infra/modules/app-service.bicep](../infra/modules/app-service.bicep).

| Setting                                    | Purpose                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `ASPNETCORE_ENVIRONMENT=Production`        | Standard                                                                                |
| `ASPNETCORE_FORWARDEDHEADERS_ENABLED=true` | App Service terminates TLS; the app must honor `X-Forwarded-*`                          |
| `APPLICATIONINSIGHTS_CONNECTION_STRING`    | App Insights auto-instrumentation                                                       |
| `Database__Provider=SqlServer`             | Switches EF Core provider                                                               |
| `ConnectionStrings__SqlServer`             | Passwordless: `Server=tcp:...;Authentication=Active Directory Default;Encrypt=True;...` |
| `Jwt__SigningKey`                          | `@Microsoft.KeyVault(VaultName=...;SecretName=jwt-signing-key)`                         |
| `Cors__AllowedOrigins__0`                  | SWA hostname (`https://<swa>.azurestaticapps.net`)                                      |
| `RUN_MIGRATIONS_ON_START=true`             | Opt-in flag for `Database.Migrate()` on startup                                         |

The frontend receives `VITE_API_BASE_URL` at build time (stamped in by [.github/workflows/\_deploy.yml](../.github/workflows/_deploy.yml)).

### Outstanding app-code work

The infra deploys successfully today, but the app will not start until these are implemented:

- [ ] `backend/Notes.Api/Program.cs`: read CORS origins from `Cors:AllowedOrigins` instead of hardcoded `localhost:5173`; add `UseForwardedHeaders` guarded on `ASPNETCORE_FORWARDEDHEADERS_ENABLED`; guard `db.Database.Migrate()` with `RUN_MIGRATIONS_ON_START` instead of `IsDevelopment`.
- [ ] `AddPersistence`: when `Database:Provider=SqlServer`, pass the connection string to `UseSqlServer` as-is (EF Core 10 / SqlClient 5 handle `Authentication=Active Directory Default`).
- [ ] `frontend/src/api/http.ts`: prefix request URLs with `import.meta.env.VITE_API_BASE_URL`.

## Troubleshooting

**`Error: jwt-signing-key not found`** — first deploy should seed it; re-run the `Seed JWT signing key` step or create manually with `az keyvault secret set`.

**App returns 500 on every request, logs show `Login failed for user '<token-identified principal>'`** — the App Service managed identity wasn't granted to the SQL database. Re-run the `Grant App Service MI access to SQL DB` step. Confirm the app name matches the SQL user (the step uses the App Service name, which is the default AAD login name for its MI).

**SQL deploy fails with `useFreeLimit` error** — the free serverless offer is limited to one database per subscription. Set `useFreeLimit: false` in [infra/modules/sql.bicep](../infra/modules/sql.bicep) or consume the offer elsewhere.

**SWA deploy succeeds but app shows CORS errors** — confirm `Cors__AllowedOrigins__0` on the App Service matches the actual SWA hostname; the Bicep wires this automatically but a manually edited setting will drift.

**OIDC login fails with `AADSTS70021`** — the federated credential subject doesn't match. Verify the GitHub repo, owner, and environment name exactly match what was registered by `setup-oidc.sh`.
