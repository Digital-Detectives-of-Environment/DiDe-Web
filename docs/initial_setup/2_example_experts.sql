-- 1) Introduce the password directly to the trigger
SELECT set_config('app.password_plain', '12345Aa!.', true);

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
('unimib1',
 crypt('12345Aa!.', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'unimib1@unimib.it',
 true,
 true,
 true
),
-- 2
('unimib2',
 crypt('12345Aa!.', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'unimib2@unimib.it',
 true,
 true,
 true
),
-- 3
('secam1',
 crypt('12345Aa!.', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'secam1@secam.net',
 true,
 true,
 true
),
-- 4
('polimi1',
 crypt('12345Aa!.', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'polimi1@polimi.it',
 true,
 true,
 true
),
--5
('iss1',
 crypt('12345Aa!.', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'iss1@iss.it',
 true,
 true,
 true
),
--6
('lombardia1',
 crypt('12345Aa!.', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'lombardia1@regione.lombardia.it',
 true,
 true,
 true
),
--7
('hacettepe1',
 crypt('12345Aa!.', gen_salt('bf', 10)),
 'user',
 NULL,
 NULL,
 'hacettepe1@hacettepe.edu.tr',
 true,
 true,
 true
);