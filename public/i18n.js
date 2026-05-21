const translations = {
  tr: {
    application: 'Uygulama',
    close: 'Kapat',
    back: 'Geri',
    cancel: 'İptal',
    save: 'Kaydet',
    delete: 'Sil',
    update: 'Güncelle',
    submit: 'Gönder',
    search: 'Ara',
    selectAll: 'Tümünü Seç',
    yes: 'Evet',
    no: 'Hayır',
    error: 'Hata',
    success: 'Başarılı',
    
    allowedDomainSingular: 'Kayıt için izin verilen alan: {{domain}}',
    allowedDomainsPlural: 'Kayıt için izin verilen alanlar: {{domains}}',
    
    addPhoto: 'Fotoğraf Ekle',
    addVideo: 'Video Ekle',
    photo: 'Fotoğraf',
    video: 'Video',
    noPhoto: 'Fotoğraf yok',
    noVideo: 'Video yok',
    takePhoto: 'Fotoğraf Çek',
    recordVideo: 'Video Kaydet',
    gallery: 'Galeri',
    capture: 'Çek',
    retake: 'Tekrar Çek',
    use: 'Kullan',
    startRecording: 'Kaydı Başlat',
    stopRecording: 'Kaydı Durdur',
    deletePhoto: 'Fotoğrafı Sil',
    deleteVideo: 'Videoyu Sil',
    confirmRemovePhoto: 'Bu fotoğrafı kaldırmak istediğinize emin misiniz?',
    confirmRemoveVideo: 'Bu videoyu kaldırmak istediğinize emin misiniz?',
    photoRemoved: 'Fotoğraf kaldırıldı',
    videoRemoved: 'Video kaldırıldı',
    
    location: 'Konum',
    useMyLocation: 'Konumumu Kullan',
    cancelLocation: 'Konumu İptal Et',
    myLocation: 'Konumum',
    selectedLocation: 'Seçili konum',
    stopTracking: 'Takibi Durdur',
    
    eventIcons: 'Olay İkonları',
    myEvent: 'Benim Olayım',
    otherEvents: 'Diğer Olaylar',
    withPhoto: 'Fotoğraflı',
    withVideo: 'Videolu',
    withPhotoAndVideo: 'Foto + Video',
    
    eventReportForm: 'Olay Bildirimi Formu',
    eventType: 'Olay Türü',
    description: 'Açıklama',
    pleaseSelect: 'Seçiniz',
    enterDescription: 'Açıklama girin...',
    latitude: 'Enlem',
    longitude: 'Boylam',
    selectFromMap: 'Haritadan seçin',
    editing: 'Düzenleniyor',
    name: 'Ad',
    surname: 'Soyad',
    
    type: 'Tür',
    typeName: 'Tür Adı',
    good: 'Açık mı?',
    beneficial: 'Açık (Public)',
    notBeneficial: 'Gizli (Private)',
    beneficialToCitizen: 'Açık (Public)',
    notBeneficialToCitizen: 'Gizli (Private)',
    isBeneficial: 'Açık mı?',
    newEventTypeName: 'Yeni olay türü adı',
    add: 'Ekle',
    eventTypes: 'Olay Türleri',
    name: 'Ad',
    createdBy: 'Oluşturan',
    actions: 'İşlemler',
    save: 'Kaydet',
    next: 'İleri',
    back: 'Geri',
    cancel: 'İptal',
    update: 'Güncelle',
    saveFailed: 'Kaydedilemedi',
    savedSuccessfully: 'Kaydedildi',
    existingData: 'Mevcut Veri',
    vtLayerTable: 'Katman Tablosu',
    vtAttributeColumn: 'Öznitelik Sütunu',
    vtEventType: 'Olay Türü',
    vtSelectLayerTable: 'Katman tablosu seç',
    vtTablesDescription: 'Line / Polygon geometri içeren tablolar listelenir.',
    vtSelectColumn: 'Öznitelik sütunu seç',
    vtColumnDescription: 'Seçtiğin tablonun sütunlarından birini seç.',
    vtLoadingColumns: 'Yükleniyor...',
    vtSelectColumnPlaceholder: 'Sütun Seç',
    vtBulkOption: 'Tüm veriyi tek seferde işaretle (opsiyonel)',
    vtBulkNone: 'Tek tek seçeceğim (sonraki adıma geç)',
    vtBulkPublic: 'Bütün veri Açık (Public) olsun',
    vtBulkPrivate: 'Bütün veri Gizli (Private) olsun',
    vtSelectValues: 'Değerleri seç',
    vtSelectAllValues: 'Bu sütundaki değerlerin hepsini seç',
    vtAllSelected: 'Hepsi seçili ({{count}} değer)',
    vtMinOneValue: 'En az 1 değer seç',
    vtSaveDescription: 'Seçilen değerler için hedef tabloya olay_turu kolonu eklenir ve uygun satırlara o_id yazılır. Seçilmemiş satırlar NULL kalır ve haritada görünmez.',
    
    users: 'Kullanıcılar',
    username: 'Kullanıcı Adı',
    email: 'E-posta',
    role: 'Rol',
    verified: 'Doğrulandı',
    
    events: 'Olaylar',
    addEvent: 'Olay Ekle',
    eventID: 'Olay ID',
    mine: 'Benim',
    other: 'Diğer',
    addedBy: 'Ekleyen',
    addedDate: 'Eklenme Tarihi',
    dateAdded: 'Eklenme Tarihi',
    available: 'Var',
    notAvailable: 'Yok',
    
    login: 'Giriş',
    logout: 'Çıkış',
    signUp: 'Kayıt Ol',
    greeting: 'Merhaba, {{username}} ({{role}})',
    usernameOrEmail: 'Kullanıcı Adı veya E-posta',
    password: 'Parola',
    verificationCode: 'Doğrulama Kodu (2FA)',
    verificationCodeRequired: 'Admin/Supervisor için gerekli',
    forgotPassword: 'Parolamı Unuttum?',
    dontHaveAccount: 'Hesabınız yok mu?',
    alreadyHaveAccount: 'Zaten hesabınız var mı?',
    firstName: 'Ad',
    lastName: 'Soyad',
    resetPassword: 'Parola Sıfırla',
    resetPasswordSteps: 'Parolanızı 3 adımda sıfırlayın: E-posta → Kod → Yeni Parola',
    registeredEmail: 'Kayıtlı e-posta',
    sendCode: 'Kod Gönder',
    verifyCode: 'Kodu Doğrula',
    newPassword: 'Yeni Parola',
    confirmNewPassword: 'Yeni Parolayı Onayla',
    backToLogin: 'Giriş Ekranına Dön',
    
    administrationPanel: 'Yönetim Paneli',
    managementPanel: 'Yönetim Paneli',
    view: 'Görünüm',
    management: 'Yönetim',
    eventView: 'Olay Görünümü',
    
    searchPlaceholder: 'Ara: Mayıs, 2025, 14 Mayıs 2025, 01:00...',
    searchCommonWord: 'Ara: ortak kelime...',
    newestFirst: 'En Son Eklenen Başta',
    oldestFirst: 'İlk Eklenen Başta',
    customFilters: 'Özel Filtreler',
    emailDomains: 'E-posta Domain\'leri',
    
    yearFilter: '{{year}} Yılı',
    monthFilter: '{{month}} Ayı',
    dayFilter: '{{day}}. Gün',
    yearRangeFilter: '{{start}} - {{end}} Yılları Arası',
    dayRangeFilter: '{{start}} - {{end}}. Günler Arası',
    timeRangeFilter: '{{start}} - {{end}} Arası',
    
    months: ['ocak', 'şubat', 'mart', 'nisan', 'mayıs', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasım', 'aralık'],
    
    showingTotalRecords: 'Toplam {{total}} kayıt gösteriliyor',
    showingFilteredRecords: 'Toplam {{total}} kayıttan {{filtered}} kayıt gösteriliyor',
    showingRangeRecords: '{{start}}-{{end}} arası gösteriliyor (Toplam: {{total}})',
    showingRangeFilteredRecords: '{{start}}-{{end}} arası gösteriliyor (Toplam {{total}} kayıttan {{filtered}} kayıt)',
    
    noRecordsFound: 'Kayıt bulunamadı',
    noEventsToDownload: 'İndirilecek olay yok',
    eventsDownloaded: 'Olaylar indirildi',
    geojsonDownloaded: 'GeoJSON indirildi',
    geojsonDownloadFailed: 'GeoJSON indirilemedi',
    downloadError: 'İndirme hatası',
    download: 'İndir',
    downloadFilteredEventsGeoJSON: 'Filtrelenmiş olayları GeoJSON olarak indir',
    downloadVisibleEventsGeoJSON: 'Haritada görünen olayları GeoJSON indir',
    
    pleaseEnterTypeName: 'Lütfen tür adı girin',
    pleaseEnterLocation: 'Lütfen konum girin',
    pleaseSelectEventType: 'Lütfen bir olay türü seçin',
    usernamePasswordRequired: 'Kullanıcı adı ve parola zorunludur',
    usernameEmailPasswordRequired: 'Kullanıcı adı, e-posta ve parola zorunludur',
    emailRequired: 'E-posta zorunludur',
    emailCodeRequired: 'E-posta ve kod zorunludur',
    fillAllFields: 'Tüm alanları doldurun',
    passwordsDoNotMatch: 'Parolalar eşleşmiyor',
    weakPassword: 'Zayıf parola: En az 8 karakter, bir büyük, bir küçük harf ve bir sembol içermeli',
    typeNameRequired: 'Olay türü adı boş olamaz',
    noChanges: 'Değişiklik yapılmadı',
    noPermission: 'Yetkiniz yok',
    
    loginSuccessful: 'Giriş başarılı',
    registrationSuccessfulCheckEmail: 'Kayıt başarılı! Lütfen e-postanızı kontrol edin (varsa doğrulama için)',
    verificationCodeSent: 'Doğrulama kodu e-postanıza gönderildi (5 dk geçerli)',
    codeVerifiedEnterNewPassword: 'Kod doğrulandı, yeni parolanızı girin',
    passwordResetSuccessCanLogin: 'Parolanız sıfırlandı! Giriş yapabilirsiniz',
    newTypeAdded: 'Yeni olay türü eklendi',
    typeUpdated: 'Olay türü güncellendi',
    typeDeleted: 'Olay türü silindi',
    userDeleted: 'Kullanıcı silindi',
    eventAdded: 'Olay eklendi (#{{id}})',
    eventUpdated: 'Olay güncellendi (#{{id}})',
    eventDeleted: 'Olay silindi',
    videoAdded: 'Video eklendi',
    
    unknownError: 'Bilinmeyen hata',
    loginFailed: 'Giriş başarısız',
    loginError: 'Giriş hatası',
    registrationFailed: 'Kayıt başarısız',
    registrationError: 'Kayıt hatası',
    codeNotSent: 'Kod gönderilemedi',
    codeNotVerified: 'Kod doğrulanamadı',
    passwordNotReset: 'Parola sıfırlanamadı',
    eventTypesLoadFailed: 'Olay türleri yüklenemedi',
    typeAddFailed: 'Olay türü eklenemedi',
    duplicateTypeError: 'Aynı ad ile olay türü ekleyemezsiniz (Aktif veya pasif bir kayıt mevcut)',
    updateFailed: 'Güncelleme başarısız',
    updateError: 'Güncelleme hatası',
    deleteFailed: 'Silme başarısız',
    deleteError: 'Silme hatası',
    operationError: 'İşlem hatası',
    readError: 'Okuma hatası',
    uploadError: 'Yükleme hatası',
    photoUploadFailed: 'Foto yüklenemedi',
    videoUploadFailed: 'Video yüklenemedi',
    videoUploadError: 'Video yükleme hatası',
    invalidResponse: 'Geçersiz yanıt',
    
    confirmDeleteEvent: 'Olay silinsin mi?',
    confirmDeleteType: 'Bu tür ve bağlı olaylar silinsin mi?',
    confirmDeleteUser: 'Kullanıcı silinsin mi?',
    confirmDeleteOwnAccount: 'Kendi hesabınızı silmek istediğinize emin misiniz?',
    accountDeactivatedRedirect: 'Hesabınız pasifleştirildi. Giriş ekranına yönlendiriliyorsunuz.',
    
    cameraPermissionDenied: 'Kamera izni reddedildi veya bulunamadı. Galeriden seçebilirsiniz.',
    cameraNotOpened: 'Kamera açılmadı',
    videoRecordingNotSupported: 'Cihaz video kaydı desteklemiyor. Galeriden video seçin',
    recordingStartFailed: 'Kayıt başlatılamadı',
    videoRecordingError: 'Video kaydında hata',
    recordingNotCreated: 'Kayıt oluşmadı, tekrar deneyin',
    
    voiceToText: 'Sesle yaz',
    microphone: 'Mikrofon',
    browserNoSpeechRecognition: 'Tarayıcı konuşma tanımıyor',
    
    supervisorCannotAdd: 'Supervisor ekleyemez',
    
    pleaseEnterVerificationCode: 'Lütfen doğrulama kodunu girin',
    
    usernameOrEmailPlaceholder: 'kullanici_adi veya ornek@email.com',
    usernamePlaceholder: 'kullanici_adi',
    passwordPlaceholder: '••••••••',
    weakPasswordPlaceholder: 'En az 8 karakter, büyük/küçük harf, sembol',
    firstNamePlaceholder: 'Adınız',
    lastNamePlaceholder: 'Soyadınız',
    registeredEmailPlaceholder: 'kayitli@email.com',
    newPasswordPlaceholder: 'Yeni parolanız',
    confirmNewPasswordPlaceholder: 'Yeni parolanızı tekrar girin',
    enterDescriptionPlaceholder: 'Açıklama girin...',
    selectFromMapPlaceholder: 'Haritadan seçin',
    newEventTypeNamePlaceholder: 'Yeni olay türü adı',
    typeNamePlaceholder: 'Tür adı',

    outsideWorkArea: 'Çalışma bölgesinin dışındasınız',
    confirmRegion: 'Bulunduğunuz bölge doğru mu?',
    regionConfirmed: 'Bölge onaylandı',
    reviewExistingRecords: 'Mevcut kayıtları incelemek ister misiniz?',
    existingRecordsTitle: 'Bu Bölgedeki Mevcut Kayıtlar',
    existingRecordCount: '{{count}} mevcut kayıt bulundu',
    noExistingRecords: 'Bu bölgede henüz kayıt yok',
    wantToAddRecord: 'Kayıt eklemek ister misiniz?',
    findMyRegion: 'Bölgemi Bul',
    regionSearch: 'Bölge Ara',
    noRegionData: 'Bölge verisi bulunamadı',
    selectAll: 'Tümünü Seç',
    selectedRow: 'Seçili satır',
    continueToForm: 'Olay Bildirimine Devam Et',
    returnToMap: 'Ana Ekrana Dön',
    recordDate: 'Tarih',
    recordType: 'Olay Türü',
    polygonNotConfigured: 'Poligon katmanı yapılandırılmamış',

    // GeoJSON Import
    importGeoJSON: 'GeoJSON İçe Aktar',
    selectEventTypeForImport: 'İçe aktarılacak olay türünü seçin',
    next: 'İleri',
    epsgWarning: 'Yüklenecek GeoJSON dosyası EPSG:4326 formatında olmalıdır.',
    selectGeoJSONFile: 'GeoJSON Dosyası Seçin',
    chooseFile: 'Dosya Seç',
    noFileChosen: 'Dosya seçilmedi',
    hasDescriptionColumn: 'Bu dosyada açıklama sütunu var mı?',
    yes: 'Evet',
    no: 'Hayır',
    selectDescriptionColumn: 'Açıklama sütununu seçin',
    importing: 'İçe aktarılıyor...',
    importSuccess: 'İçe aktarma başarılı',
    importComplete: 'İçe aktarma tamamlandı',
    pointsInsideGrid: '{{count}} nokta grid içinde — eklendi',
    pointsOutsideGrid: '{{count}} nokta grid dışında — eklenmedi',
    totalPointsProcessed: 'Toplam {{count}} nokta işlendi',
    noFeaturesFound: 'GeoJSON dosyasında nokta bulunamadı',
    invalidGeoJSON: 'Geçersiz GeoJSON dosyası',
    importFailed: 'İçe aktarma başarısız',
    allPointsOutside: 'Tüm noktalar grid sınırları dışında, hiç eklenmedi',

    // Grid boundary
    updateOutsideGrid: 'Lütfen grid sınırları içerisinde güncelleme yapınız',
    cannotAddOutsideGrid: 'Grid dışında nokta eklenemez'
  },
  
  en: {
    application: 'Application',
    close: 'Close',
    back: 'Back',
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    update: 'Update',
    submit: 'Submit',
    search: 'Search',
    selectAll: 'Select All',
    yes: 'Yes',
    no: 'No',
    error: 'Error',
    success: 'Success',
    
    allowedDomainSingular: 'Allowed domain for registration: {{domain}}',
    allowedDomainsPlural: 'Allowed domains for registration: {{domains}}',
    
    addPhoto: 'Add Photo',
    addVideo: 'Add Video',
    photo: 'Photo',
    video: 'Video',
    noPhoto: 'No photo',
    noVideo: 'No video',
    takePhoto: 'Take Photo',
    recordVideo: 'Record Video',
    gallery: 'Gallery',
    capture: 'Capture',
    retake: 'Retake',
    use: 'Use',
    startRecording: 'Start Recording',
    stopRecording: 'Stop Recording',
    deletePhoto: 'Delete Photo',
    deleteVideo: 'Delete Video',
    confirmRemovePhoto: 'Are you sure you want to remove this photo?',
    confirmRemoveVideo: 'Are you sure you want to remove this video?',
    photoRemoved: 'Photo removed',
    videoRemoved: 'Video removed',
    
    location: 'Location',
    useMyLocation: 'Use My Location',
    cancelLocation: 'Cancel Location',
    myLocation: 'My Location',
    selectedLocation: 'Selected location',
    stopTracking: 'Stop Tracking',
    
    eventIcons: 'Event Icons',
    myEvent: 'My Event',
    otherEvents: 'Other Events',
    withPhoto: 'With Photo',
    withVideo: 'With Video',
    withPhotoAndVideo: 'Photo + Video',
    
    eventReportForm: 'Event Report Form',
    eventType: 'Event Type',
    description: 'Description',
    pleaseSelect: 'Please Select',
    enterDescription: 'Enter description...',
    latitude: 'Latitude',
    longitude: 'Longitude',
    selectFromMap: 'Select from map',
    editing: 'Editing',
    name: 'Name',
    surname: 'Surname',
    
    type: 'Type',
    good: 'Is it public?',
    typeName: 'Type Name',
    beneficial: 'Public',
    notBeneficial: 'Private',
    beneficialToCitizen: 'Public',
    notBeneficialToCitizen: 'Private',
    isBeneficial: 'Is it public?',
    newEventTypeName: 'New event type name',
    add: 'Add',
    eventTypes: 'Event Types',
    name: 'Name',
    createdBy: 'Created By',
    actions: 'Actions',
    save: 'Save',
    next: 'Next',
    back: 'Back',
    cancel: 'Cancel',
    update: 'Update',
    saveFailed: 'Save failed',
    savedSuccessfully: 'Saved successfully',
    existingData: 'Existing Data',
    vtLayerTable: 'Layer Table',
    vtAttributeColumn: 'Attribute Column',
    vtEventType: 'Event Type',
    vtSelectLayerTable: 'Select layer table',
    vtTablesDescription: 'Tables containing Line / Polygon geometry are listed.',
    vtSelectColumn: 'Select attribute column',
    vtColumnDescription: 'Select a column from the chosen table.',
    vtLoadingColumns: 'Loading...',
    vtSelectColumnPlaceholder: 'Select Column',
    vtBulkOption: 'Mark all data at once (optional)',
    vtBulkNone: 'I will select individually (go to next step)',
    vtBulkPublic: 'All data should be Public',
    vtBulkPrivate: 'All data should be Private',
    vtSelectValues: 'Select values',
    vtSelectAllValues: 'Select all values in this column',
    vtAllSelected: 'All selected ({{count}} values)',
    vtMinOneValue: 'Select at least 1 value',
    vtSaveDescription: 'An event_type column will be added to the target table and o_id will be written to matching rows. Unselected rows will remain NULL and will not appear on the map.',
    
    users: 'Users',
    username: 'Username',
    email: 'Email',
    role: 'Role',
    verified: 'Verified',
    
    events: 'Events',
    addEvent: 'Add Event',
    eventID: 'Event ID',
    mine: 'Mine',
    other: 'Other',
    addedBy: 'Added By',
    addedDate: 'Date Added',
    dateAdded: 'Date Added',
    available: 'Available',
    notAvailable: 'Not Available',
    
    login: 'Login',
    logout: 'Logout',
    signUp: 'Sign Up',
    greeting: 'Hello, {{username}} ({{role}})',
    usernameOrEmail: 'Username or Email',
    password: 'Password',
    verificationCode: 'Verification Code (2FA)',
    verificationCodeRequired: 'Required for Admin/Supervisor',
    forgotPassword: 'Forgot Password?',
    dontHaveAccount: "Don't have an account?",
    alreadyHaveAccount: 'Already have an account?',
    firstName: 'First Name',
    lastName: 'Last Name',
    resetPassword: 'Reset Password',
    resetPasswordSteps: 'Reset your password in 3 steps: Email → Code → New Password',
    registeredEmail: 'Registered email',
    sendCode: 'Send Code',
    verifyCode: 'Verify Code',
    newPassword: 'New Password',
    confirmNewPassword: 'Confirm New Password',
    backToLogin: 'Back to Login',
    
    administrationPanel: 'Administration Panel',
    managementPanel: 'Management Panel',
    view: 'View',
    management: 'Management',
    eventView: 'Event View',
    
    searchPlaceholder: 'Search: May, 2025, May 14 2025, 01:00...',
    searchCommonWord: 'Search: common word...',
    newestFirst: 'Newest First',
    oldestFirst: 'Oldest First',
    customFilters: 'Custom Filters',
    emailDomains: 'Email Domains',
    
    yearFilter: 'Year {{year}}',
    monthFilter: '{{month}} Month',
    dayFilter: 'Day {{day}}',
    yearRangeFilter: 'Years {{start}} - {{end}}',
    dayRangeFilter: 'Days {{start}} - {{end}}',
    timeRangeFilter: '{{start}} - {{end}}',
    
    months: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
    
    showingTotalRecords: 'Showing {{total}} total records',
    showingFilteredRecords: 'Showing {{filtered}} of {{total}} total records',
    showingRangeRecords: 'Showing {{start}}-{{end}} (Total: {{total}})',
    showingRangeFilteredRecords: 'Showing {{start}}-{{end}} ({{filtered}} of {{total}} total records)',
    
    noRecordsFound: 'No records found',
    noEventsToDownload: 'No events to download',
    eventsDownloaded: 'Events downloaded',
    geojsonDownloaded: 'GeoJSON downloaded',
    geojsonDownloadFailed: 'GeoJSON download failed',
    downloadError: 'Download error',
    download: 'Download',
    downloadFilteredEventsGeoJSON: 'Download filtered events as GeoJSON',
    downloadVisibleEventsGeoJSON: 'Download visible events on map as GeoJSON',
    
    pleaseEnterTypeName: 'Please enter type name',
    pleaseEnterLocation: 'Please enter location',
    pleaseSelectEventType: 'Please select an event type',
    usernamePasswordRequired: 'Username and password are required',
    usernameEmailPasswordRequired: 'Username, email and password are required',
    emailRequired: 'Email is required',
    emailCodeRequired: 'Email and code are required',
    fillAllFields: 'Fill all fields',
    passwordsDoNotMatch: 'Passwords do not match',
    weakPassword: 'Weak password: Must contain at least 8 characters, one uppercase, one lowercase letter and one special character',
    typeNameRequired: 'Event type name cannot be empty',
    noChanges: 'No changes made',
    noPermission: 'No permission',
    
    loginSuccessful: 'Login successful',
    registrationSuccessfulCheckEmail: 'Registration successful! Please check your email (if verification is required)',
    verificationCodeSent: 'Verification code sent to your email (valid for 5 minutes)',
    codeVerifiedEnterNewPassword: 'Code verified, enter your new password',
    passwordResetSuccessCanLogin: 'Password reset! You can now login',
    newTypeAdded: 'New event type added',
    typeUpdated: 'Event type updated',
    typeDeleted: 'Event type deleted',
    userDeleted: 'User deleted',
    eventAdded: 'Event added (#{{id}})',
    eventUpdated: 'Event updated (#{{id}})',
    eventDeleted: 'Event deleted',
    videoAdded: 'Video added',
    
    unknownError: 'Unknown error',
    loginFailed: 'Login failed',
    loginError: 'Login error',
    registrationFailed: 'Registration failed',
    registrationError: 'Registration error',
    codeNotSent: 'Code could not be sent',
    codeNotVerified: 'Code could not be verified',
    passwordNotReset: 'Password could not be reset',
    eventTypesLoadFailed: 'Event types could not be loaded',
    typeAddFailed: 'Event type could not be added',
    duplicateTypeError: 'Cannot add event type with the same name (An active or inactive record already exists)',
    updateFailed: 'Update failed',
    updateError: 'Update error',
    deleteFailed: 'Delete failed',
    deleteError: 'Delete error',
    operationError: 'Operation error',
    readError: 'Read error',
    uploadError: 'Upload error',
    photoUploadFailed: 'Photo upload failed',
    videoUploadFailed: 'Video upload failed',
    videoUploadError: 'Video upload error',
    invalidResponse: 'Invalid response',
    
    confirmDeleteEvent: 'Delete event?',
    confirmDeleteType: 'Delete this type and related events?',
    confirmDeleteUser: 'Delete user?',
    confirmDeleteOwnAccount: 'Are you sure you want to delete your own account?',
    accountDeactivatedRedirect: 'Your account has been deactivated. Redirecting to login screen.',
    
    cameraPermissionDenied: 'Camera permission denied or not found. You can select from gallery.',
    cameraNotOpened: 'Camera not opened',
    videoRecordingNotSupported: 'Device does not support video recording. Select video from gallery',
    recordingStartFailed: 'Recording could not be started',
    videoRecordingError: 'Video recording error',
    recordingNotCreated: 'Recording not created, try again',
    
    voiceToText: 'Voice to Text',
    microphone: 'Microphone',
    browserNoSpeechRecognition: 'Browser does not support speech recognition',
    
    supervisorCannotAdd: 'Supervisor cannot add',
    
    pleaseEnterVerificationCode: 'Please enter verification code',
    
    usernameOrEmailPlaceholder: 'username or example@email.com',
    usernamePlaceholder: 'username',
    passwordPlaceholder: '••••••••',
    weakPasswordPlaceholder: 'Min 8 chars, upper/lower case, symbol',
    firstNamePlaceholder: 'Your name',
    lastNamePlaceholder: 'Your surname',
    registeredEmailPlaceholder: 'registered@email.com',
    newPasswordPlaceholder: 'Your new password',
    confirmNewPasswordPlaceholder: 'Re-enter new password',
    enterDescriptionPlaceholder: 'Enter description...',
    selectFromMapPlaceholder: 'Select from map',
    newEventTypeNamePlaceholder: 'New event type name',
    typeNamePlaceholder: 'Type name',

    outsideWorkArea: 'You are outside the work area',
    confirmRegion: 'Are you in the correct grid?',
    regionConfirmed: 'Region confirmed',
    reviewExistingRecords: 'Would you like to review existing records?',
    existingRecordsTitle: 'Existing Records in This Area',
    existingRecordCount: '{{count}} existing record(s) found',
    noExistingRecords: 'No records in this area yet',
    wantToAddRecord: 'Would you like to add a record?',
    findMyRegion: 'Find My Region',
    regionSearch: 'Search Region',
    noRegionData: 'No region data found',
    selectAll: 'Select All',
    selectedRow: 'Selected row',
    continueToForm: 'Continue to Event Report',
    returnToMap: 'Return to Map',
    recordDate: 'Date',
    recordType: 'Event Type',
    polygonNotConfigured: 'Polygon layer not configured',

    // GeoJSON Import
    importGeoJSON: 'Import GeoJSON',
    selectEventTypeForImport: 'Select event type for import',
    next: 'Next',
    epsgWarning: 'The GeoJSON file to be uploaded must be in EPSG:4326 format.',
    selectGeoJSONFile: 'Select GeoJSON File',
    chooseFile: 'Choose File',
    noFileChosen: 'No file chosen',
    hasDescriptionColumn: 'Does this file have a description column?',
    yes: 'Yes',
    no: 'No',
    selectDescriptionColumn: 'Select description column',
    importing: 'Importing...',
    importSuccess: 'Import successful',
    importComplete: 'Import complete',
    pointsInsideGrid: '{{count}} point(s) inside grid — added',
    pointsOutsideGrid: '{{count}} point(s) outside grid — not added',
    totalPointsProcessed: '{{count}} total point(s) processed',
    noFeaturesFound: 'No point features found in GeoJSON file',
    invalidGeoJSON: 'Invalid GeoJSON file',
    importFailed: 'Import failed',
    allPointsOutside: 'All points are outside grid boundaries, none were added',

    // Grid boundary
    updateOutsideGrid: 'Please update within grid boundaries',
    cannotAddOutsideGrid: 'Cannot add points outside the grid'
  }
};

let currentLanguage = 'tr';

function replacePlaceholders(str, params) {
  if (!params) return str;
  return str.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return params[key] !== undefined ? params[key] : match;
  });
}

function t(key, params) {
  const keys = key.split('.');
  let value = translations[currentLanguage];
  
  for (const k of keys) {
    if (value && typeof value === 'object') {
      value = value[k];
    } else {
      break;
    }
  }
  
  if (typeof value === 'string') {
    return replacePlaceholders(value, params);
  }
  
  if (currentLanguage !== 'tr') {
    let fallback = translations['tr'];
    for (const k of keys) {
      if (fallback && typeof fallback === 'object') {
        fallback = fallback[k];
      } else {
        break;
      }
    }
    if (typeof fallback === 'string') {
      return replacePlaceholders(fallback, params);
    }
  }
  
  return key;
}

function setLanguage(lang) {
  if (translations[lang]) {
    currentLanguage = lang;
    try {
      localStorage.setItem('app_language', lang);
    } catch {}
    
    document.documentElement.lang = lang;
    
    window.dispatchEvent(new CustomEvent('languagechange', { detail: { language: lang } }));
  }
}

function getLanguage() {
  return currentLanguage;
}

function initLanguage() {
  try {
    const saved = localStorage.getItem('app_language');
    if (saved && translations[saved]) {
      currentLanguage = saved;
      document.documentElement.lang = saved;
    }
  } catch {}
}

window.t = t;
window.setLanguage = setLanguage;
window.getLanguage = getLanguage;
window.i18n = {
  t,
  setLanguage,
  getLanguage,
  translations
};

initLanguage();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('i18n loaded and ready');
  });
} else {
  console.log('i18n loaded and ready');
}