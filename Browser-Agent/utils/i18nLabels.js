/**
 * utils/i18nLabels.js
 *
 * GENERATED FILE — do not hand-edit.
 *
 * Source of truth: utils/i18n/packs/*.json (one file per language, pure
 * data, no code). Regenerate with:
 *
 *   node utils/i18n/build-language-packs.js
 *
 * Adding a language is a data contribution: drop a new pack file that
 * satisfies utils/i18n/schema.json, run the build script, done — no
 * change to this file (or any other .js file) is written by hand. This
 * is the mechanism behind Pillar 6 of the v07 system design doc: the set
 * of supported languages is a growing, swappable config, not a hardcoded
 * assumption about which two languages an Indian user might read.
 *
 * Generated at: 2026-09-17T19:31:32.032Z
 * Packs included: hi-IN, mr-IN
 */
(function (root) {
  // Registry of supported languages beyond English (which lives inline
  // in content.js's buildFieldInfo). Keyed by BCP-47 tag used for both
  // the toggle button label and the SpeechSynthesisUtterance.lang.
  const LANGUAGES = {
    "hi-IN": {
      label: "हिं",
      table: {
      pan: {
        title: "पैन कार्ड नंबर",
        subtitle: "स्थायी खाता संख्या",
        desc: "अपने पैन कार्ड पर छपा हुआ 10 अंकों/अक्षरों का नंबर बिना स्पेस के दर्ज करें।",
        hint: "फॉर्मैट: 5 अक्षर · 4 अंक · 1 अक्षर"
      },
      aadhaar: {
        title: "आधार नंबर",
        subtitle: "UIDAI 12-अंकीय पहचान संख्या",
        desc: "अपना 12 अंकों का आधार नंबर दर्ज करें। यह आपके आधार कार्ड या ई-आधार पीडीएफ़ पर मिलेगा।",
        hint: "स्पेस देना ज़रूरी नहीं है"
      },
      upi: {
        title: "यूपीआई पिन / वीपीए",
        subtitle: "यूनिफ़ाइड पेमेंट्स इंटरफ़ेस",
        desc: "अपना यूपीआई पता या 4/6 अंकों का यूपीआई पिन दर्ज करें, जैसा आपके बैंक ऐप में दर्ज है।",
        hint: "पिन कभी सेव या भेजा नहीं जाता"
      },
      email: {
        title: "ईमेल पता",
        subtitle: "आपका पंजीकृत ईमेल",
        desc: "अपने खाते से जुड़ा ईमेल पता मानक ईमेल फॉर्मैट में दर्ज करें।",
        hint: "@ और सही डोमेन नाम ज़रूरी है"
      },
      phone: {
        title: "मोबाइल नंबर",
        subtitle: "पंजीकृत फ़ोन नंबर",
        desc: "बिना देश कोड या स्पेस के अपना 10 अंकों का मोबाइल नंबर दर्ज करें।",
        hint: "+91 या शुरुआती शून्य न लगाएं"
      },
      password: {
        title: "पासवर्ड",
        subtitle: "आपके खाते का पासवर्ड",
        desc: "अपना पासवर्ड दर्ज करें। इसे कभी सेव, लॉग या किसी सर्वर पर नहीं भेजा जाता — यह सीधे पेज पर टाइप होता है।",
        hint: "सीधे पेज पर टाइप करें, कभी कैप्चर नहीं होता"
      },
      dob: {
        title: "जन्म तिथि",
        subtitle: "सरकारी दस्तावेज़ों के अनुसार",
        desc: "फ़ील्ड में दिखाए गए फॉर्मैट में अपनी जन्मतिथि दर्ज करें — आमतौर पर DD/MM/YYYY या YYYY-MM-DD।",
        hint: "डेट पिकर या दिए गए फॉर्मैट का उपयोग करें"
      },
      name: {
        title: "पूरा नाम",
        subtitle: "सरकारी दस्तावेज़ों के अनुसार",
        desc: "अपना पूरा कानूनी नाम वैसे ही दर्ज करें जैसे आपके सरकारी पहचान पत्र या बैंक रिकॉर्ड पर है।",
        hint: "उपनाम या संक्षिप्त नाम न लिखें"
      },
      ifsc: {
        title: "आईएफ़एससी कोड",
        subtitle: "बैंक शाखा पहचान कोड",
        desc: "अपनी बैंक शाखा का 11 अंकों/अक्षरों का आईएफ़एससी कोड दर्ज करें। यह आपकी चेकबुक या पासबुक पर मिलेगा।",
        hint: "फॉर्मैट: 4 अक्षर · 0 · 6 अंक/अक्षर"
      },
      account: {
        title: "खाता संख्या",
        subtitle: "बैंक खाता संख्या",
        desc: "अपने पासबुक में दी गई पूरी बैंक खाता संख्या बिना स्पेस या डैश के दर्ज करें।",
        hint: "आमतौर पर 9–18 अंक, बैंक के अनुसार अलग हो सकता है"
      },
      generic: {
        title: "आवश्यक फ़ील्ड",
        subtitle: "एजेंट को आपकी जानकारी चाहिए",
        desc: "कृपया पेज पर हाइलाइट की गई फ़ील्ड में सीधे आवश्यक जानकारी दर्ज करें।",
        hint: "हाइलाइट की गई फ़ील्ड में सीधे टाइप करें"
      }
      }
    },
    "mr-IN": {
      label: "मरा",
      table: {
      pan: {
        title: "पॅन कार्ड क्रमांक",
        subtitle: "कायमस्वरूपी खाते क्रमांक",
        desc: "तुमच्या पॅन कार्डवर छापलेला 10 अंकी/अक्षरी क्रमांक स्पेसशिवाय टाका.",
        hint: "फॉरमॅट: 5 अक्षरे · 4 अंक · 1 अक्षर"
      },
      aadhaar: {
        title: "आधार क्रमांक",
        subtitle: "UIDAI 12-अंकी ओळख क्रमांक",
        desc: "तुमचा 12 अंकी आधार क्रमांक टाका. हा तुमच्या आधार कार्डवर किंवा ई-आधार पीडीएफवर मिळेल.",
        hint: "स्पेस देणे बंधनकारक नाही"
      },
      upi: {
        title: "यूपीआय पिन / व्हीपीए",
        subtitle: "युनिफाइड पेमेंट्स इंटरफेस",
        desc: "तुमचा यूपीआय पत्ता किंवा 4/6 अंकी यूपीआय पिन टाका, जो तुमच्या बँक अ‍ॅपमध्ये नोंदवलेला आहे.",
        hint: "पिन कधीही सेव्ह किंवा पाठवला जात नाही"
      },
      email: {
        title: "ईमेल पत्ता",
        subtitle: "तुमचा नोंदणीकृत ईमेल",
        desc: "तुमच्या खात्याशी जोडलेला ईमेल पत्ता योग्य ईमेल फॉरमॅटमध्ये टाका.",
        hint: "@ आणि योग्य डोमेन नाव आवश्यक आहे"
      },
      phone: {
        title: "मोबाईल क्रमांक",
        subtitle: "नोंदणीकृत फोन क्रमांक",
        desc: "देश कोड किंवा स्पेसशिवाय तुमचा 10 अंकी मोबाईल क्रमांक टाका.",
        hint: "+91 किंवा सुरुवातीचे शून्य टाकू नका"
      },
      password: {
        title: "पासवर्ड",
        subtitle: "तुमच्या खात्याचा पासवर्ड",
        desc: "तुमचा पासवर्ड टाका. तो कधीही सेव्ह, लॉग किंवा कोणत्याही सर्व्हरवर पाठवला जात नाही — तो थेट पेजवर टाइप होतो.",
        hint: "थेट पेजवर टाइप करा, कधीही कॅप्चर होत नाही"
      },
      dob: {
        title: "जन्मतारीख",
        subtitle: "शासकीय कागदपत्रांनुसार",
        desc: "फील्डमध्ये दाखवलेल्या फॉरमॅटमध्ये तुमची जन्मतारीख टाका — साधारणपणे DD/MM/YYYY किंवा YYYY-MM-DD.",
        hint: "डेट पिकर किंवा दिलेला फॉरमॅट वापरा"
      },
      name: {
        title: "पूर्ण नाव",
        subtitle: "शासकीय कागदपत्रांनुसार",
        desc: "तुमचे पूर्ण कायदेशीर नाव, तुमच्या शासकीय ओळखपत्रावर किंवा बँक नोंदींवर आहे तसेच टाका.",
        hint: "टोपणनाव किंवा संक्षिप्त नाव लिहू नका"
      },
      ifsc: {
        title: "आयएफएससी कोड",
        subtitle: "बँक शाखा ओळख कोड",
        desc: "तुमच्या बँक शाखेचा 11 अंकी/अक्षरी आयएफएससी कोड टाका. हा तुमच्या चेकबुक किंवा पासबुकवर मिळेल.",
        hint: "फॉरमॅट: 4 अक्षरे · 0 · 6 अंक/अक्षरे"
      },
      account: {
        title: "खाते क्रमांक",
        subtitle: "बँक खाते क्रमांक",
        desc: "तुमच्या पासबुकमध्ये दिलेला संपूर्ण बँक खाते क्रमांक स्पेस किंवा डॅशशिवाय टाका.",
        hint: "साधारणपणे 9–18 अंक, बँकेनुसार वेगळे असू शकते"
      },
      generic: {
        title: "आवश्यक फील्ड",
        subtitle: "एजंटला तुमची माहिती हवी आहे",
        desc: "कृपया पेजवर ठळक केलेल्या फील्डमध्ये थेट आवश्यक माहिती टाका.",
        hint: "ठळक केलेल्या फील्डमध्ये थेट टाइप करा"
      }
      }
    }
  };

  function getTranslation(langTag, key) {
    const lang = LANGUAGES[langTag];
    if (!lang) return null;
    return lang.table[key] || lang.table.generic || null;
  }

  root.__BA_I18nLabels = {
    LANGUAGES,
    getTranslation,
    // Back-compat direct accessor for the default (Hindi) table.
    getHindi: (key) => getTranslation('hi-IN', key)
  };
})(typeof window !== 'undefined' ? window : self);
