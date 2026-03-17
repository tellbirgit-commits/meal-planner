import React, { useState, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { 
  Calendar as CalendarIcon, 
  Plus, 
  Trash2, 
  AlertCircle, 
  Utensils,
  X,
  CheckCircle2,
  Sparkles,
  Package,
  Edit3,
  Loader2,
  Share2,
  LogIn,
  LogOut,
  Users,
  Copy,
  Mail,
  GripVertical,
  Sun,
  Moon,
  AlertTriangle,
  ShoppingCart,
  Info
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { 
  collection, 
  doc, 
  onSnapshot, 
  setDoc, 
  deleteDoc, 
  query, 
  where,
  getDoc,
  getDocs,
  updateDoc,
  arrayUnion,
  serverTimestamp,
  writeBatch,
  getDocFromServer
} from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';
import { db, auth, signInWithGoogle, logout } from './firebase';
import { MealEntry, MealType } from './types';
import { PREFILLED_MEALS } from './prefilledData';

// --- Utils ---

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

const handleFirestoreError = (error: unknown, operationType: OperationType, path: string | null) => {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  // We don't throw here to avoid crashing the UI, but we log it for the system to see
  return errInfo;
};

const getDaysArray = (days: number) => {
  const arr = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    arr.push(d.toISOString().split('T')[0]);
  }
  return arr;
};

const formatDate = (dateStr: string) => {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { 
    weekday: 'short', 
    month: 'short', 
    day: 'numeric' 
  });
};

const getPublicOrigin = () => {
  const origin = window.location.origin;
  // If we are in the AI Studio dev environment, replace -dev- with -pre-
  if (origin.includes('-dev-')) {
    return origin.replace('-dev-', '-pre-');
  }
  return origin;
};

// --- Main Component ---

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [householdId, setHouseholdId] = useState<string | null>(localStorage.getItem('meal-planner-household-id'));
  const [householdName, setHouseholdName] = useState<string | null>(null);
  
  const [meals, setMeals] = useState<MealEntry[]>([]);
  const [pantry, setPantry] = useState<string[]>(() => {
    const saved = localStorage.getItem('meal-planner-pantry');
    return saved ? JSON.parse(saved) : ['Soy Sauce', 'Coconut Milk', 'Rice Vinegar', 'Garlic', 'Onions', 'Vinegars'];
  });

  const [newMealName, setNewMealName] = useState('');
  const [newPantryItem, setNewPantryItem] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedType, setSelectedType] = useState<MealType>('dinner');
  const [warning, setWarning] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);
  const [shoppingList, setShoppingList] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGeneratingShoppingList, setIsGeneratingShoppingList] = useState(false);
  const [showShoppingList, setShowShoppingList] = useState(false);
  const [showRecipe, setShowRecipe] = useState<MealEntry | null>(null);
  const [recipeContent, setRecipeContent] = useState<string | null>(null);
  const [isGeneratingRecipe, setIsGeneratingRecipe] = useState(false);
  const [conflictAlternatives, setConflictAlternatives] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);

  const [isCreatingHousehold, setIsCreatingHousehold] = useState(false);
  const [householdNameInput, setHouseholdNameInput] = useState('');
  const [showHouseholdModal, setShowHouseholdModal] = useState<'create' | 'join' | null>(null);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');

  const days = useMemo(() => getDaysArray(60), []);
  const ai = useMemo(() => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }), []);

  // Connection Test
  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. The client is offline.");
        }
      }
    }
    testConnection();
  }, []);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Handle Invitation Link
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const joinId = params.get('join');
    
    if (joinId) {
      if (!user && !isLoading) {
        setWarning("Please login to join the shared household.");
      } else if (user && householdId !== joinId) {
        const joinFromLink = async () => {
          try {
            const hDoc = await getDoc(doc(db, 'households', joinId));
            if (hDoc.exists()) {
              // Check if already a member to avoid redundant updates
              const data = hDoc.data();
              if (!data.members.includes(user.uid)) {
                await updateDoc(doc(db, 'households', joinId), {
                  members: arrayUnion(user.uid)
                });
              }
              setHouseholdId(joinId);
              localStorage.setItem('meal-planner-household-id', joinId);
              setSuccess(`Successfully joined ${data.name}!`);
              // Clear URL param
              window.history.replaceState({}, document.title, window.location.pathname);
            } else {
              setWarning("Invitation link is invalid or household no longer exists.");
            }
          } catch (error) {
            console.error("Error joining from link:", error);
            handleFirestoreError(error, OperationType.UPDATE, `households/${joinId}`);
            setWarning("Failed to join household. Check your connection.");
          }
        };
        joinFromLink();
      }
    }
  }, [user, householdId, isLoading]);

  // Household Listener
  useEffect(() => {
    if (!householdId || !user) return;
    
    const unsubscribe = onSnapshot(doc(db, 'households', householdId), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        setHouseholdName(data.name);
        if (data.pantry) {
          setPantry(data.pantry);
        }
      } else {
        setHouseholdId(null);
        localStorage.removeItem('meal-planner-household-id');
      }
    }, (error) => {
      console.error("Household snapshot error:", error);
      if (error.code === 'permission-denied') {
        setHouseholdId(null);
        localStorage.removeItem('meal-planner-household-id');
      }
      handleFirestoreError(error, OperationType.GET, `households/${householdId}`);
    });
    return () => unsubscribe();
  }, [householdId, user]);

  // Meals Listener (Real-time Sync)
  useEffect(() => {
    if (!householdId) {
      // Fallback to local storage or prefilled data if not in a household
      const saved = localStorage.getItem('meal-planner-local-meals');
      if (saved) {
        try {
          setMeals(JSON.parse(saved));
        } catch (e) {
          setMeals(PREFILLED_MEALS);
        }
      } else {
        setMeals(PREFILLED_MEALS);
      }
      setIsLoading(false);
      return;
    }

    if (!user) return;

    const q = collection(db, 'households', householdId, 'meals');
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const mealData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as MealEntry[];
      setMeals(mealData);
    });

    return () => unsubscribe();
  }, [householdId, user]);

  // Auto-discover household if not set
  useEffect(() => {
    if (user && !householdId && !isLoading) {
      const q = query(collection(db, 'households'), where('members', 'array-contains', user.uid));
      getDocs(q).then(snapshot => {
        if (!snapshot.empty) {
          const id = snapshot.docs[0].id;
          setHouseholdId(id);
          localStorage.setItem('meal-planner-household-id', id);
        }
      }).catch(err => {
        console.error("Discovery error:", err);
      });
    }
  }, [user, householdId, isLoading]);

  // Sync Pantry with localStorage and Firebase
  useEffect(() => {
    localStorage.setItem('meal-planner-pantry', JSON.stringify(pantry));
    
    if (householdId && user) {
      const syncPantry = async () => {
        try {
          await updateDoc(doc(db, 'households', householdId), {
            pantry: pantry
          });
        } catch (error) {
          console.error("Error syncing pantry:", error);
        }
      };
      syncPantry();
    }
  }, [pantry, householdId, user]);

  const handleCreateHousehold = async () => {
    if (!user || !householdNameInput.trim()) return;
    const name = householdNameInput.trim();

    setIsCreatingHousehold(true);
    try {
      const newHouseholdRef = doc(collection(db, 'households'));
      const newId = newHouseholdRef.id;

      await setDoc(newHouseholdRef, {
        name,
        ownerId: user.uid,
        members: [user.uid],
        pantry: pantry // Initialize with current local pantry
      });

      setHouseholdId(newId);
      localStorage.setItem('meal-planner-household-id', newId);
      
      // Seed with prefilled data using batches (max 500 per batch)
      const batch = writeBatch(db);
      PREFILLED_MEALS.forEach((meal) => {
        const mealRef = doc(db, 'households', newId, 'meals', meal.id);
        batch.set(mealRef, {
          ...meal,
          updatedBy: user.uid,
          updatedAt: new Date().toISOString()
        });
      });
      
      await batch.commit();
      setSuccess("Household created and data synced!");
      setShowHouseholdModal(null);
      setHouseholdNameInput('');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'households');
      setWarning("Failed to create household. Check your connection.");
    } finally {
      setIsCreatingHousehold(false);
    }
  };

  const handleJoinHousehold = async () => {
    if (!user || !householdNameInput.trim()) return;
    const id = householdNameInput.trim();

    setIsCreatingHousehold(true);
    try {
      const hDoc = await getDoc(doc(db, 'households', id));
      if (hDoc.exists()) {
        await updateDoc(doc(db, 'households', id), {
          members: arrayUnion(user.uid)
        });
        setHouseholdId(id);
        localStorage.setItem('meal-planner-household-id', id);
        setSuccess("Joined household successfully!");
        setShowHouseholdModal(null);
        setHouseholdNameInput('');
      } else {
        setWarning("Household not found.");
      }
    } catch (error) {
      console.error("Error joining household:", error);
      setWarning("Failed to join household. Check the ID.");
    } finally {
      setIsCreatingHousehold(false);
    }
  };

  const [draggedMeal, setDraggedMeal] = useState<{id: string, name: string} | null>(null);

  const onDragStart = (e: React.DragEvent, meal: MealEntry) => {
    setDraggedMeal({ id: meal.id, name: meal.name });
    e.dataTransfer.setData('mealId', meal.id);
    e.dataTransfer.setData('text/plain', meal.id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const onDragStartPantry = (e: React.DragEvent, itemName: string) => {
    e.dataTransfer.setData('pantryItem', itemName);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const onDragEnd = () => {
    setDraggedMeal(null);
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const onDrop = async (e: React.DragEvent, targetDate: string, targetType: MealType) => {
    e.preventDefault();
    const mealId = e.dataTransfer.getData('mealId');
    const pantryItem = e.dataTransfer.getData('pantryItem');

    if (pantryItem) {
      handleInlineEdit(targetDate, targetType, pantryItem);
      return;
    }

    const meal = meals.find(m => m.id === mealId);
    
    if (!meal) return;
    if (meal.date === targetDate && meal.type === targetType) return;

    // Check if target already has a meal
    const existingAtTarget = meals.find(m => m.date === targetDate && m.type === targetType);
    
    // Validate the move for the dragged meal
    if (!validateMeal(meal.name, targetDate, targetType, meal.id)) return;
    
    // If there's an existing meal at target, validate its move to the source position
    if (existingAtTarget && !validateMeal(existingAtTarget.name, meal.date, meal.type, existingAtTarget.id)) return;

    if (!householdId || !user) {
      // Local mode
      let updatedMeals = meals.filter(m => m.id !== meal.id);
      if (existingAtTarget) {
        updatedMeals = updatedMeals.filter(m => m.id !== existingAtTarget.id);
        // Move existing to source
        updatedMeals.push({ 
          ...existingAtTarget, 
          date: meal.date, 
          type: meal.type, 
          id: `${meal.date}_${meal.type}` 
        });
      }
      // Move dragged to target
      updatedMeals.push({ 
        ...meal, 
        date: targetDate, 
        type: targetType, 
        id: `${targetDate}_${targetType}` 
      });
      
      setMeals(updatedMeals);
      localStorage.setItem('meal-planner-local-meals', JSON.stringify(updatedMeals));
    } else {
      // Shared mode
      try {
        const batch = writeBatch(db);
        
        // 1. Move dragged meal to target
        const newIdForDragged = `${targetDate}_${targetType}`;
        batch.set(doc(db, 'households', householdId, 'meals', newIdForDragged), {
          date: targetDate,
          type: targetType,
          name: meal.name,
          updatedBy: user.uid,
          updatedAt: new Date().toISOString()
        });

        // 2. If target had a meal, move it to source. Otherwise delete source.
        if (existingAtTarget) {
          const newIdForExisting = `${meal.date}_${meal.type}`;
          batch.set(doc(db, 'households', householdId, 'meals', newIdForExisting), {
            date: meal.date,
            type: meal.type,
            name: existingAtTarget.name,
            updatedBy: user.uid,
            updatedAt: new Date().toISOString()
          });
        } else {
          // No meal at target, so just delete the source
          batch.delete(doc(db, 'households', householdId, 'meals', meal.id));
        }

        await batch.commit();
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `households/${householdId}/meals`);
      }
    }
    setDraggedMeal(null);
  };

  const getAiSuggestions = async () => {
    if (pantry.length === 0) return;
    setIsGenerating(true);
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Based on these pantry items: ${pantry.join(', ')}, suggest 3 simple meal names. Return ONLY a JSON array of strings.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
          },
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        }
      });
      const suggestions = JSON.parse(response.text);
      setAiSuggestions(suggestions);
    } catch (error) {
      console.error("AI Error:", error);
    } finally {
      setIsGenerating(false);
    }
  };

  const generateShoppingList = async () => {
    const next7Days = days.slice(0, 7);
    const plannedMeals = meals.filter(m => next7Days.includes(m.date));
    
    if (plannedMeals.length === 0) {
      setWarning("No meals planned for the next 7 days.");
      return;
    }

    setIsGeneratingShoppingList(true);
    setShowShoppingList(true);
    
    try {
      const mealList = plannedMeals.map(m => `${m.name} (${m.type})`).join(', ');
      const pantryList = pantry.join(', ');
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `I have planned these meals for the next week: ${mealList}. 
                   My pantry already contains: ${pantryList}. 
                   What ingredients do I need to buy? 
                   Return ONLY a JSON array of strings. Be concise.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
          },
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        }
      });
      
      const list = JSON.parse(response.text);
      setShoppingList(list);
    } catch (error) {
      console.error("Shopping List Error:", error);
      setWarning("Failed to generate shopping list.");
    } finally {
      setIsGeneratingShoppingList(false);
    }
  };

  const getRecipe = async (meal: MealEntry) => {
    setShowRecipe(meal);
    setRecipeContent(null);
    setIsGeneratingRecipe(true);
    
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Provide a very brief recipe and ingredients list for "${meal.name}". 
                   Keep it under 150 words. Use Markdown for formatting.`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        }
      });
      setRecipeContent(response.text);
    } catch (error) {
      console.error("Recipe Error:", error);
      setRecipeContent("Failed to generate recipe. Please try again.");
    } finally {
      setIsGeneratingRecipe(false);
    }
  };

  const getAlternative = async (meal: { name: string, date: string, type: MealType }, forceNew = false) => {
    const key = `${meal.date}_${meal.type}`;
    if (!forceNew && conflictAlternatives[key] || !meal.name.trim()) return;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `The user planned "${meal.name}" for ${meal.type} on ${meal.date}, but they already had it recently. 
                   Suggest ONE alternative meal name that is different but suitable for ${meal.type}. 
                   Consider these pantry items: ${pantry.join(', ')}.
                   Return ONLY the meal name string. Be creative but simple.`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        }
      });
      const alternative = response.text.trim().replace(/^"|"$/g, '');
      setConflictAlternatives(prev => ({ ...prev, [key]: alternative }));
    } catch (error) {
      console.error("Alternative Error:", error);
    }
  };

  const getViolation = (meal: MealEntry) => {
    const targetDate = new Date(meal.date);
    const normalizedName = meal.name.trim().toLowerCase();
    if (!normalizedName || normalizedName === 'jäägid') return null;

    return meals.find(m => {
      if (m.id === meal.id) return false;
      if (m.name.toLowerCase() !== normalizedName) return false;
      
      const mDate = new Date(m.date);
      const diffTime = targetDate.getTime() - mDate.getTime();
      const diffDays = Math.round(Math.abs(diffTime) / (1000 * 60 * 60 * 24));
      
      if (diffDays >= 14) return false;

      // Leftover Exception:
      // If current is lunch and it was planned on the PREVIOUS day, it's a leftover.
      const isCurrentLunch = meal.type === 'lunch';
      const isNextDay = diffTime === (1000 * 60 * 60 * 24); // Exactly 1 day later
      
      if (isCurrentLunch && isNextDay) {
        return false;
      }

      // Reverse Leftover Exception (if we are looking at the previous day's meal and the next day's lunch is already planned)
      const isConflictLunch = m.type === 'lunch';
      const isPrevDay = diffTime === -(1000 * 60 * 60 * 24); // Exactly 1 day earlier

      if (isConflictLunch && isPrevDay) {
        return false;
      }

      return true;
    });
  };

  const validateMeal = (name: string, date: string, type: MealType, currentId?: string) => {
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName) return true;

    const tempMeal: MealEntry = {
      id: currentId || 'temp',
      name,
      date,
      type
    };

    const conflict = getViolation(tempMeal);

    if (conflict) {
      const conflictDate = formatDate(conflict.date);
      setWarning(`Warning: "${name}" was planned on ${conflictDate} (${conflict.type}). Please wait 14 days between repeats.`);
      return false;
    }

    setWarning(null);
    return true;
  };

  const handleAddMeal = async (e?: React.FormEvent, nameOverride?: string) => {
    if (e) e.preventDefault();
    const name = nameOverride || newMealName;
    if (!name.trim()) return;

    if (validateMeal(name, selectedDate, selectedType)) {
      if (!householdId || !user) {
        // Local only if not logged in/no household
        const id = `${selectedDate}_${selectedType}`;
        const existingMealIndex = meals.findIndex(m => m.id === id || (m.date === selectedDate && m.type === selectedType));
        
        let updatedMeals;
        if (existingMealIndex > -1) {
          updatedMeals = [...meals];
          updatedMeals[existingMealIndex] = { id, date: selectedDate, type: selectedType, name: name.trim() };
        } else {
          updatedMeals = [...meals, { id, date: selectedDate, type: selectedType, name: name.trim() }];
        }
        
        setMeals(updatedMeals);
        localStorage.setItem('meal-planner-local-meals', JSON.stringify(updatedMeals));
        setSuccess(`Planned ${selectedType} "${name}" (Local only)`);
      } else {
        const mealId = `${selectedDate}_${selectedType}`;
        try {
          await setDoc(doc(db, 'households', householdId, 'meals', mealId), {
            date: selectedDate,
            type: selectedType,
            name: name.trim(),
            updatedBy: user.uid,
            updatedAt: new Date().toISOString()
          });
          setSuccess(`Planned ${selectedType} "${name}"`);
        } catch (error) {
          console.error("Error saving meal:", error);
          alert("Failed to save meal. Check security rules.");
        }
      }
      
      if (!nameOverride) setNewMealName('');
      setTimeout(() => setSuccess(null), 3000);
    }
  };

  const handleInlineEdit = async (date: string, type: MealType, newName: string) => {
    if (!householdId || !user) {
      // Local mode inline edit
      const existingMeal = meals.find(m => m.date === date && m.type === type);
      
      if (!newName) {
        if (existingMeal) {
          const updatedMeals = meals.filter(m => m.id !== existingMeal.id);
          setMeals(updatedMeals);
          localStorage.setItem('meal-planner-local-meals', JSON.stringify(updatedMeals));
        }
        return;
      }

    // We still validate to show the warning, but we don't block the edit anymore
    // This allows users to type through temporary states (like deleting a letter and adding it back)
    validateMeal(newName, date, type, existingMeal?.id);

    let updatedMeals;
    if (existingMeal) {
      updatedMeals = meals.map(m => m.id === existingMeal.id ? { ...m, name: newName } : m);
    } else {
      updatedMeals = [...meals, { id: `${date}_${type}`, date, type, name: newName }];
    }
    setMeals(updatedMeals);
    localStorage.setItem('meal-planner-local-meals', JSON.stringify(updatedMeals));
    return;
  }
  
  const mealId = `${date}_${type}`;
  if (!newName) {
    try {
      await deleteDoc(doc(db, 'households', householdId, 'meals', mealId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `households/${householdId}/meals/${mealId}`);
    }
    return;
  }

  // Show warning but don't block the write
  validateMeal(newName, date, type, mealId);

  try {
    await setDoc(doc(db, 'households', householdId, 'meals', mealId), {
      date,
      type,
      name: newName,
      updatedBy: user.uid,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `households/${householdId}/meals/${mealId}`);
  }
};

  const handleRemoveMeal = async (id: string) => {
    if (!householdId || !user) {
      const updatedMeals = meals.filter(m => m.id !== id);
      setMeals(updatedMeals);
      localStorage.setItem('meal-planner-local-meals', JSON.stringify(updatedMeals));
    } else {
      try {
        await deleteDoc(doc(db, 'households', householdId, 'meals', id));
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, `households/${householdId}/meals/${id}`);
      }
    }
  };

  const handleAddPantry = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPantryItem.trim()) return;
    if (!pantry.includes(newPantryItem.trim())) {
      setPantry([...pantry, newPantryItem.trim()]);
    }
    setNewPantryItem('');
  };

  const handleRemovePantry = (item: string) => {
    setPantry(pantry.filter(i => i !== item));
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="animate-spin text-emerald-500" size={48} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F9FAFB] text-[#111827] font-sans p-4 md:p-12">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="mb-10 flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              Interval
            </h1>
            <div className="flex items-center gap-2 text-[11px] font-medium text-slate-400 mt-1 uppercase tracking-wider">
              <span>{meals.length} meals planned</span>
              <span>•</span>
              <span>14-day cooldown active</span>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            {user ? (
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-[11px] font-bold text-slate-900 leading-none">{user.displayName}</div>
                  <div className="text-[9px] text-slate-400 font-medium mt-1 uppercase tracking-tight">{householdName || 'Personal'}</div>
                </div>
                <button 
                  onClick={logout}
                  className="p-1.5 text-slate-300 hover:text-slate-600 transition-colors"
                  title="Logout"
                >
                  <LogOut size={16} />
                </button>
              </div>
            ) : (
              <button 
                onClick={signInWithGoogle}
                className="text-[11px] font-bold uppercase tracking-widest text-slate-400 hover:text-slate-900 transition-colors"
              >
                Login
              </button>
            )}
          </div>
        </header>

        {/* Collaboration Banner */}
        {/* Collaboration Info (Subtle) */}
        {user && !householdId && (
          <div className="mb-8 flex items-center justify-between p-4 bg-slate-50 rounded-xl border border-slate-100">
            <div className="flex items-center gap-3">
              <Users size={16} className="text-slate-400" />
              <p className="text-[12px] font-medium text-slate-500">Collaborate with your partner by creating a household.</p>
            </div>
            <div className="flex gap-2">
              <button 
                onClick={() => setShowHouseholdModal('create')}
                className="text-[11px] font-bold uppercase tracking-widest text-indigo-500 hover:text-indigo-600 transition-colors"
              >
                Create
              </button>
              <span className="text-slate-200">|</span>
              <button 
                onClick={() => setShowHouseholdModal('join')}
                className="text-[11px] font-bold uppercase tracking-widest text-slate-400 hover:text-slate-600 transition-colors"
              >
                Join
              </button>
            </div>
          </div>
        )}

        {user && householdId && (
          <div className="mb-8 flex items-center justify-between p-4 bg-white rounded-xl border border-slate-100 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <p className="text-[12px] font-medium text-slate-700">Connected to <span className="font-bold">{householdName || 'Household'}</span></p>
            </div>
            <button 
              onClick={() => setShowInviteForm(!showInviteForm)}
              className="text-[11px] font-bold uppercase tracking-widest text-slate-400 hover:text-indigo-500 transition-colors"
            >
              {showInviteForm ? 'Close' : 'Invite'}
            </button>
          </div>
        )}

        {showInviteForm && householdId && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8 p-6 bg-white rounded-xl border border-slate-100 shadow-sm"
          >
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-bold text-slate-900">Invite Partner</h3>
              <button onClick={() => setShowInviteForm(false)}><X size={16} className="text-slate-300" /></button>
            </div>
            <div className="flex gap-3">
              <input 
                type="email"
                placeholder="partner@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="flex-1 bg-slate-50 border border-slate-100 rounded-lg px-4 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
              />
              <button 
                onClick={() => {
                  if (!inviteEmail || !inviteEmail.includes('@')) return;
                  const publicOrigin = getPublicOrigin();
                  const inviteUrl = `${publicOrigin}${window.location.pathname}?join=${householdId}`;
                  window.location.href = `mailto:${inviteEmail}?subject=Join my kitchen&body=Click here: ${inviteUrl}`;
                }}
                className="px-6 py-2 bg-indigo-500 text-white text-xs font-bold rounded-lg hover:bg-indigo-600 transition-colors"
              >
                Send Invite
              </button>
            </div>
            <div className="mt-4 pt-4 border-t border-slate-50 flex items-center justify-between">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Or copy link</span>
              <button 
                onClick={async () => {
                  const publicOrigin = getPublicOrigin();
                  const inviteUrl = `${publicOrigin}${window.location.pathname}?join=${householdId}`;
                  await navigator.clipboard.writeText(inviteUrl);
                  setSuccess("Copied!");
                  setTimeout(() => setSuccess(null), 2000);
                }}
                className="text-[10px] font-bold text-indigo-500 hover:underline"
              >
                Copy Link
              </button>
            </div>
          </motion.div>
        )}

        {/* Recipe Modal */}
        <AnimatePresence>
          {showRecipe && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="bg-white rounded-3xl p-8 max-w-lg w-full shadow-2xl"
              >
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <h3 className="text-2xl font-bold text-slate-900">{showRecipe.name}</h3>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">
                      {formatDate(showRecipe.date)} • {showRecipe.type}
                    </p>
                  </div>
                  <button onClick={() => setShowRecipe(null)} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                    <X size={24} />
                  </button>
                </div>
                
                <div className="prose prose-slate prose-sm max-h-[60vh] overflow-y-auto pr-4 mb-8">
                  {isGeneratingRecipe ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-4">
                      <Loader2 size={32} className="animate-spin text-indigo-500" />
                      <p className="text-sm font-medium text-slate-400">Consulting the chef...</p>
                    </div>
                  ) : recipeContent ? (
                    <div className="markdown-body">
                      <ReactMarkdown>{recipeContent}</ReactMarkdown>
                    </div>
                  ) : null}
                </div>

                <button 
                  onClick={() => setShowRecipe(null)}
                  className="w-full py-3 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800 transition-all"
                >
                  Close
                </button>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Shopping List Modal */}
        <AnimatePresence>
          {showShoppingList && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl"
              >
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-2xl font-bold text-slate-900 flex items-center gap-3">
                    <ShoppingCart className="text-indigo-500" />
                    Shopping List
                  </h3>
                  <button onClick={() => setShowShoppingList(false)} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                    <X size={24} />
                  </button>
                </div>
                
                <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-2 mb-8">
                  {isGeneratingShoppingList ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-4">
                      <Loader2 size={32} className="animate-spin text-indigo-500" />
                      <p className="text-sm font-medium text-slate-400">Analyzing your plan...</p>
                    </div>
                  ) : shoppingList.length > 0 ? (
                    shoppingList.map((item, idx) => (
                      <div key={idx} className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100 group">
                        <div className="w-5 h-5 rounded-full border-2 border-slate-200 group-hover:border-indigo-400 transition-colors" />
                        <span className="text-sm font-medium text-slate-600">{item}</span>
                      </div>
                    ))
                  ) : (
                    <p className="text-center text-slate-400 py-8">No items found. Try planning more meals!</p>
                  )}
                </div>

                <button 
                  onClick={() => setShowShoppingList(false)}
                  className="w-full py-3 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800 transition-all"
                >
                  Got it
                </button>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {showHouseholdModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl"
              >
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-2xl font-bold text-slate-900">
                    {showHouseholdModal === 'create' ? 'Create Household' : 'Join Household'}
                  </h3>
                  <button onClick={() => setShowHouseholdModal(null)} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                    <X size={24} />
                  </button>
                </div>
                
                <p className="text-slate-500 mb-6">
                  {showHouseholdModal === 'create' 
                    ? 'Give your household a name to start sharing your meal plan.' 
                    : 'Enter the ID shared by your partner to join their household.'}
                </p>

                <div className="space-y-4">
                  <input 
                    type="text"
                    value={householdNameInput}
                    onChange={(e) => setHouseholdNameInput(e.target.value)}
                    placeholder={showHouseholdModal === 'create' ? "e.g. The Smith Kitchen" : "Enter Household ID"}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none transition-all"
                    autoFocus
                  />
                  
                  <button 
                    onClick={showHouseholdModal === 'create' ? handleCreateHousehold : handleJoinHousehold}
                    disabled={!householdNameInput.trim() || isCreatingHousehold}
                    className="w-full py-3 bg-emerald-600 text-white font-bold rounded-xl hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {isCreatingHousehold && <Loader2 size={18} className="animate-spin" />}
                    {showHouseholdModal === 'create' ? 'Create Now' : 'Join Now'}
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
          {/* Forecast */}
          <div className="lg:col-span-8">
            <div className="bg-white rounded-xl border border-slate-100 shadow-[0_1px_3px_rgba(0,0,0,0.02)] overflow-hidden">
              <div className="divide-y divide-slate-50 max-h-[85vh] overflow-y-auto custom-scrollbar">
                {days.reduce((acc: React.JSX.Element[], date, index) => {
                  const dateObj = new Date(date);
                  const month = dateObj.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();
                  const prevDate = index > 0 ? new Date(days[index - 1]) : null;
                  const prevMonth = prevDate ? prevDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase() : null;

                  if (month !== prevMonth) {
                    acc.push(
                      <div key={`month-${month}`} className="bg-slate-50/50 px-6 py-3 border-b border-slate-100">
                        <h3 className="text-[10px] font-bold text-slate-400 tracking-[0.15em]">{month}</h3>
                      </div>
                    );
                  }

                  const lunch = meals.find(m => m.date === date && m.type === 'lunch');
                  const dinner = meals.find(m => m.date === date && m.type === 'dinner');
                  const lunchConflict = lunch ? getViolation(lunch) : null;
                  const dinnerConflict = dinner ? getViolation(dinner) : null;
                  const isToday = date === new Date().toISOString().split('T')[0];

                  acc.push(
                    <div 
                      key={date} 
                      className={`flex flex-col sm:flex-row items-start sm:items-center gap-4 px-4 sm:px-6 py-4 sm:py-3 group transition-colors ${isToday ? 'bg-emerald-50/10' : 'hover:bg-slate-50/30'}`}
                    >
                      {/* Date Info */}
                      <div className="w-full sm:w-24 flex items-center gap-2 shrink-0 mb-2 sm:mb-0">
                        <span className={`text-[11px] font-bold uppercase tracking-tight ${isToday ? 'text-emerald-600' : 'text-slate-900'}`}>
                          {dateObj.toLocaleDateString('en-US', { weekday: 'short' })}
                        </span>
                        <span className="text-[11px] font-medium text-slate-400 uppercase">
                          {dateObj.getDate()} {dateObj.toLocaleDateString('en-US', { month: 'short' })}
                        </span>
                        <div className="w-1 h-1 rounded-full bg-slate-200" />
                      </div>
                      
                      {/* Slots */}
                      <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-8">
                        {/* Lunch */}
                        <div 
                          className="flex items-center gap-3 relative group/slot"
                          onDragOver={onDragOver}
                          onDrop={(e) => onDrop(e, date, 'lunch')}
                        >
                          <div 
                            draggable={!!lunch}
                            onDragStart={(e) => lunch && onDragStart(e, lunch)}
                            onDragEnd={onDragEnd}
                            className="hidden sm:block opacity-0 group-hover/slot:opacity-100 transition-opacity cursor-grab absolute -left-5"
                          >
                            <GripVertical size={12} className="text-slate-200" />
                          </div>
                          <Sun size={14} className={`${lunch ? 'text-amber-400' : 'text-slate-200'} shrink-0`} />
                          <input 
                            type="text"
                            value={lunch?.name || ''}
                            onChange={(e) => handleInlineEdit(date, 'lunch', e.target.value)}
                            placeholder="Lunch..."
                            className={`flex-1 bg-transparent text-[13px] font-medium outline-none placeholder:text-slate-200 ${lunchConflict ? 'text-amber-600' : 'text-slate-700'}`}
                          />
                          {lunch && (
                            <button 
                              onClick={() => getRecipe(lunch)}
                              className="opacity-0 group-hover/slot:opacity-100 p-1 text-slate-300 hover:text-indigo-500 transition-all"
                            >
                              <Info size={16} />
                            </button>
                          )}
                          {lunchConflict && (
                            <div className="flex items-center gap-1 shrink-0">
                              <span 
                                className="cursor-help" 
                                title={`Conflict: "${lunchConflict.name}" on ${formatDate(lunchConflict.date)} (${lunchConflict.type})`}
                              >
                                <AlertTriangle size={14} className="text-amber-400" />
                              </span>
                              {conflictAlternatives[`${date}_lunch`] ? (
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => handleInlineEdit(date, 'lunch', conflictAlternatives[`${date}_lunch`])}
                                    className="text-[10px] font-bold text-indigo-500 hover:underline bg-indigo-50 px-1.5 py-0.5 rounded"
                                    title={`Try ${conflictAlternatives[`${date}_lunch`]} instead?`}
                                  >
                                    Try {conflictAlternatives[`${date}_lunch`]}?
                                  </button>
                                  <button
                                    onClick={() => getAlternative({ name: lunch?.name || '', date, type: 'lunch' }, true)}
                                    className="text-[10px] text-slate-400 hover:text-indigo-500"
                                    title="Get another suggestion"
                                  >
                                    (Another?)
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => getAlternative({ name: lunch?.name || '', date, type: 'lunch' })}
                                  className="p-1 text-slate-300 hover:text-indigo-500 transition-all"
                                  title="Get alternative suggestion"
                                >
                                  <Sparkles size={12} />
                                </button>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Dinner */}
                        <div 
                          className="flex items-center gap-3 relative group/slot"
                          onDragOver={onDragOver}
                          onDrop={(e) => onDrop(e, date, 'dinner')}
                        >
                          <div 
                            draggable={!!dinner}
                            onDragStart={(e) => dinner && onDragStart(e, dinner)}
                            onDragEnd={onDragEnd}
                            className="hidden sm:block opacity-0 group-hover/slot:opacity-100 transition-opacity cursor-grab absolute -left-5"
                          >
                            <GripVertical size={12} className="text-slate-200" />
                          </div>
                          <Moon size={14} className={`${dinner ? 'text-indigo-400' : 'text-slate-200'} shrink-0`} />
                          <input 
                            type="text"
                            value={dinner?.name || ''}
                            onChange={(e) => handleInlineEdit(date, 'dinner', e.target.value)}
                            placeholder="Dinner..."
                            className={`flex-1 bg-transparent text-[13px] font-medium outline-none placeholder:text-slate-200 ${dinnerConflict ? 'text-amber-600' : 'text-slate-700'}`}
                          />
                          {dinner && (
                            <button 
                              onClick={() => getRecipe(dinner)}
                              className="opacity-0 group-hover/slot:opacity-100 p-1 text-slate-300 hover:text-indigo-500 transition-all"
                            >
                              <Info size={16} />
                            </button>
                          )}
                          {dinnerConflict && (
                            <div className="flex items-center gap-1 shrink-0">
                              <span 
                                className="cursor-help" 
                                title={`Conflict: "${dinnerConflict.name}" on ${formatDate(dinnerConflict.date)} (${dinnerConflict.type})`}
                              >
                                <AlertTriangle size={14} className="text-amber-400" />
                              </span>
                              {conflictAlternatives[`${date}_dinner`] ? (
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => handleInlineEdit(date, 'dinner', conflictAlternatives[`${date}_dinner`])}
                                    className="text-[10px] font-bold text-indigo-500 hover:underline bg-indigo-50 px-1.5 py-0.5 rounded"
                                    title={`Try ${conflictAlternatives[`${date}_dinner`]} instead?`}
                                  >
                                    Try {conflictAlternatives[`${date}_dinner`]}?
                                  </button>
                                  <button
                                    onClick={() => getAlternative({ name: dinner?.name || '', date, type: 'dinner' }, true)}
                                    className="text-[10px] text-slate-400 hover:text-indigo-500"
                                    title="Get another suggestion"
                                  >
                                    (Another?)
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => getAlternative({ name: dinner?.name || '', date, type: 'dinner' })}
                                  className="p-1 text-slate-300 hover:text-indigo-500 transition-all"
                                  title="Get alternative suggestion"
                                >
                                  <Sparkles size={12} />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                  return acc;
                }, [])}
              </div>
            </div>
          </div>

          {/* Pantry Sidebar */}
          <div className="lg:col-span-4">
            <div className="bg-white rounded-xl border border-slate-100 shadow-[0_1px_3px_rgba(0,0,0,0.02)] p-6 sticky top-12">
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-2">
                  <Package size={16} className="text-indigo-500" />
                  <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.2em]">Pantry Staples</h2>
                </div>
                <button 
                  onClick={generateShoppingList}
                  className="p-1.5 text-slate-300 hover:text-indigo-500 transition-colors"
                  title="Generate Shopping List"
                >
                  <ShoppingCart size={16} />
                </button>
              </div>
              
              <div className="space-y-1 mb-8">
                {pantry.map((item) => (
                  <div 
                    key={item} 
                    className="flex items-center justify-between group py-1.5"
                    draggable
                    onDragStart={(e) => onDragStartPantry(e, item)}
                  >
                    <div className="flex items-center gap-3">
                      <GripVertical size={12} className="text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab" />
                      <span className="text-[13px] font-medium text-slate-600">{item}</span>
                    </div>
                    <button 
                      onClick={() => handleRemovePantry(item)}
                      className="opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-red-400 transition-all"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>

              <form onSubmit={handleAddPantry} className="flex items-center gap-2 pt-4 border-t border-slate-50">
                <input 
                  type="text" 
                  value={newPantryItem}
                  onChange={(e) => setNewPantryItem(e.target.value)}
                  placeholder="Add item..."
                  className="flex-1 text-[13px] font-medium bg-slate-50/50 px-3 py-2 rounded-lg outline-none focus:bg-slate-50 transition-colors placeholder:text-slate-300"
                />
                <button type="submit" className="p-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-all shadow-sm">
                  <Plus size={16} />
                </button>
              </form>

              {aiSuggestions.length > 0 && (
                <div className="mt-8 pt-8 border-t border-slate-50">
                  <div className="flex items-center gap-2 mb-4">
                    <Sparkles size={14} className="text-amber-400" />
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">AI Suggestions</span>
                  </div>
                  <div className="space-y-2">
                    {aiSuggestions.map((s) => (
                      <button 
                        key={s}
                        onClick={() => handleAddMeal(undefined, s)}
                        className="w-full text-left px-3 py-2 text-[12px] font-medium bg-slate-50/50 hover:bg-emerald-50 hover:text-emerald-700 rounded-lg transition-all flex items-center justify-between group"
                      >
                        {s}
                        <Plus size={12} className="opacity-0 group-hover:opacity-100" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              
              <button 
                onClick={getAiSuggestions}
                disabled={isGenerating || pantry.length === 0}
                className="w-full mt-6 py-2.5 text-[11px] font-bold uppercase tracking-widest text-slate-400 hover:text-indigo-500 disabled:opacity-30 transition-colors flex items-center justify-center gap-2"
              >
                {isGenerating ? <Loader2 size={14} className="animate-spin" /> : 'Generate Ideas'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #E2E8F0;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #CBD5E1;
        }
      `}</style>
    </div>
  );
}
