-- 1) Introduce the password directly to the trigger
SELECT set_config('app.password_plain', '12345Aa', true);

-- 2) Add users
INSERT INTO public.users (
    username,
    password_hash,
    role,
    name,
    surname,
    email,
    email_verified,
    is_verified,
    is_active
) VALUES
-- 1
('hu',
 crypt('12345Aa', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'hu@hacettepe.edu.tr',
 true,
 true,
 true
),
-- 2
('afad1',
 crypt('12345Aa', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'afad1@afad.gov.tr',
 true,
 true,
 true
),
-- 3
('afad2',
 crypt('12345Aa', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'afad2@afad.gov.tr',
 true,
 true,
 true
),
-- 4
('afad3',
 crypt('12345Aa', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'afad3@afad.gov.tr',
 true,
 true,
 true
),
-- 5
('hgm1',
 crypt('12345Aa', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'hgm1@harita.gov.tr',
 true,
 true,
 true
),
-- 6
('hgm2',
 crypt('12345Aa', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'hgm2@harita.gov.tr',
 true,
 true,
 true
),
-- 7
('cbs1',
 crypt('12345Aa', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'cbs1@csb.gov.tr',
 true,
 true,
 true
),
-- 8
('cbs2',
 crypt('12345Aa', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'cbs2@csb.gov.tr',
 true,
 true,
 true
);
