--1. Obtaining the base32 password code in the terminal:
node generate-2fa-secret.js

--2. Adding a supervisor in PostgreSQL. The resulting base32 code will be added to "two_factor_secret":
-- There can be multiple supervisors.
-- A separate base32 code must be generated for each.
INSERT INTO public.users (
    username,
    password_hash,
    role,
    name,
    surname,
    email,
    email_verified,
    is_verified,
    is_active,
    two_factor_secret,
    two_factor_enabled
) VALUES (
    'HU_supervisor',
    crypt('12345Aa.', gen_salt('bf', 10)),
    'supervisor',
    'Berk',
    'Anbaroğlu',
    'banbar@hacettepe.edu.tr',
     TRUE,
     TRUE,
     TRUE,
     'N5FUYRJZOFGCQQJ7F5RCQSJKKVWV4SDL',
     TRUE
);



-- Adding a second supervisor:
INSERT INTO public.users (
    username,
    password_hash,
    role,
    name,
    surname,
    email,
    email_verified,
    is_verified,
    is_active,
    two_factor_secret,
    two_factor_enabled
) VALUES (
    'afad_supervisor',
    crypt('123456Aa.', gen_salt('bf', 10)),
    'supervisor',
    'İbrahim',
    'Topcu',
    'ibrahim_supervisor@afad.gov.tr',
     TRUE,
     TRUE,
     TRUE,
     'IQ3FOZSVJQWE2OTVJV4UKKTIEE3UQKKB',
     TRUE
);

--3. Entering the base32 code into the Authenticator app on the supervisor's mobile phone
