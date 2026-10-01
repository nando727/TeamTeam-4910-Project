# erd diagram

```mermaid
erDiagram
    users ||--o{ sponsor_applications : "applies as driver"
    sponsors ||--o{ sponsor_applications : receives
    users ||--o| driver_sponsors : joins
    sponsors ||--o{ driver_sponsors : enrolls
    driver_sponsors { int driver_id PK,FK
                      int sponsor_id FK
                      int point_balance
                      timestamp joined_at }
    users ||--o{ setup_tokens : "is issued"
    users { int id PK
            varchar username UK
            varchar password_hash
            enum role
            enum status
            varchar name
            varchar email }
    sponsors { int id PK
               varchar name
               varchar contact_email UK
               varchar address
               enum status }
    sponsor_applications { int id PK
                           int driver_id FK
                           int sponsor_id FK
                           enum status
                           varchar rejection_reason }
    setup_tokens { int id PK
                   int user_id FK
                   char token_hash UK
                   datetime expires_at
                   datetime used_at }
    login_attempts { int id PK
                     varchar username
                     boolean success }
                %% login_attempts has no foreign key b/c it records attempts against usernames that don't exist
                %% which a foreign key would prevent.
    about { int id PK
            varchar team_name
            varchar app_version }
